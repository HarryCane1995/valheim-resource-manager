using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using BepInEx;
using BepInEx.Configuration;
using HarmonyLib;
using Newtonsoft.Json;
using UnityEngine;

namespace ValheimResourceManager
{
    [BepInPlugin(PluginId, "Valheim Resource Manager", "0.1.0")]
    public sealed class Plugin : BaseUnityPlugin
    {
        public const string PluginId = "local.valheimresourcemanager";
        internal static Plugin Instance;
        private ConfigEntry<string> _endpoint, _token, _sourceId;
        private ConfigEntry<bool> _enabled, _persistedScan;
        private Harmony _harmony;
        private readonly Dictionary<Inventory, Tracked> _tracked = new Dictionary<Inventory, Tracked>();
        private readonly HashSet<Inventory> _dirty = new HashSet<Inventory>();
        private readonly Dictionary<string, ContainerRecord> _pending = new Dictionary<string, ContainerRecord>();
        private readonly HashSet<string> _destroyed = new HashSet<string>();
        private readonly HashSet<string> _observedIds = new HashSet<string>();
        private readonly Dictionary<int, PrefabInfo> _prefabs = new Dictionary<int, PrefabInfo>();
        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(2) };
        private ZDOMan _manager;
        private ZNet _net;
        private string _worldId, _worldName, _sessionId, _mode, _gameVersion;
        private long _sequence;
        private float _nextCapture, _nextDiscovery, _nextHeartbeat, _nextScan, _nextRetry;
        private string _inFlight;
        private Task<bool> _sendTask;
        private bool _warnedSend, _supported;
        private List<ZDO>[] _sectors;
        private int _sectorIndex, _objectIndex;
        private readonly HashSet<string> _scanned = new HashSet<string>();
        private FieldInfo _sectorsField;
        private FieldInfo _lastRevisionField;
        private int _decodeWarnings;

        private sealed class Tracked { public Container Container; public ZNetView View; public Action OnChanged; }
        private sealed class PrefabInfo { public string Name, DisplayName; }

        private void Awake()
        {
            Instance = this;
            _enabled = Config.Bind("Indexing", "Enabled", true, "Read-only inventory export; no gameplay or save writes.");
            _persistedScan = Config.Bind("Indexing", "ScanHostPersistedZdos", true, "Host-only bounded read-only scan of known stationary container ZDOs. Coverage remains partial.");
            _endpoint = Config.Bind("Connection", "Endpoint", "http://127.0.0.1:37841/api/ingest", "Only loopback HTTP endpoints are accepted.");
            _token = Config.Bind("Connection", "Token", "", "Local backend X-VRM-Token. An empty token disables export.");
            _sourceId = Config.Bind("Connection", "SourceId", "", "Stable ID of this installation; generated locally once.");
            if (string.IsNullOrWhiteSpace(_sourceId.Value)) _sourceId.Value = Guid.NewGuid().ToString("N");
            _gameVersion = global::Version.CurrentVersion.ToString();
            _supported = _gameVersion == "1.0.20";
            if (!_supported) { Logger.LogError("Inventory export disabled: API audited only for Valheim 1.0.20, installed " + _gameVersion + ". Rebuild/re-audit required."); return; }
            _sectorsField = typeof(ZDOMan).GetField("m_objectsBySector", BindingFlags.Instance | BindingFlags.NonPublic);
            _lastRevisionField = typeof(Container).GetField("m_lastRevision", BindingFlags.Instance | BindingFlags.NonPublic);
            if (_lastRevisionField == null || _lastRevisionField.FieldType != typeof(uint))
            { _supported = false; Logger.LogError("Export disabled: audited Container revision field unavailable."); return; }
            _harmony = new Harmony(PluginId);
            _harmony.PatchAll(typeof(Plugin).Assembly);
            Logger.LogInfo("Read-only integration ready for Valheim " + _gameVersion + "; waiting for world and configured backend token. No network ownership changes or game-save writes.");
        }

        private void Update()
        {
            if (!_supported || !_enabled.Value) return;
            try
            {
                var net = ZNet.instance;
                if (!net || net.GetWorld() == null || ZDOMan.instance == null || ZNetScene.instance == null)
                { if (_worldId != null) ResetWorld(); return; }
                string world = net.GetWorldUID().ToString(CultureInfo.InvariantCulture);
                if (_net != net || _worldId != world || _manager != ZDOMan.instance) StartWorld(net, world);
                float now = Time.realtimeSinceStartup;
                if (now >= _nextDiscovery) { Discover(); _nextDiscovery = now + 10f; }
                if (now >= _nextCapture) { CaptureDirty(); _nextCapture = now + 0.35f; }
                if (now >= _nextHeartbeat)
                {
                    foreach (var pair in _tracked.ToArray()) ObserveLoadedSafely(pair.Key, pair.Value);
                    _nextHeartbeat = now + 3f;
                }
                if (_net.IsServer() && _persistedScan.Value)
                {
                    if (_sectors == null && now >= _nextScan) BeginPersistedScan();
                    ScanBudget();
                }
                PumpSender(now);
            }
            catch (Exception ex) { Logger.LogWarning("Read-only exporter skipped update: " + ex.GetType().Name + ": " + ex.Message); }
        }

        private void StartWorld(ZNet net, string world)
        {
            ResetWorld();
            _net = net; _manager = ZDOMan.instance; _worldId = world; _worldName = net.GetWorldName();
            _mode = net.IsServer() ? (net.IsDedicated() ? "server" : "host") : "client";
            _sessionId = Guid.NewGuid().ToString("N"); _sequence = 0;
            _manager.m_onZDODestroyed += OnZdoDestroyed;
            _nextDiscovery = _nextCapture = _nextHeartbeat = _nextScan = 0;
            BuildPrefabCatalog();
            Logger.LogInfo("Observing world " + _worldName + " (" + _worldId + "), mode=" + _mode + ", coverage=partial; stationary containers only.");
        }

        private void ResetWorld()
        {
            if (_manager != null) _manager.m_onZDODestroyed -= OnZdoDestroyed;
            foreach (var pair in _tracked) pair.Key.m_onChanged -= pair.Value.OnChanged;
            _tracked.Clear(); _dirty.Clear(); _pending.Clear(); _destroyed.Clear(); _observedIds.Clear(); _prefabs.Clear(); _scanned.Clear();
            _manager = null; _net = null; _worldId = null; _worldName = null; _sectors = null;
            // A previous request may complete, but its immutable body still contains its original world/session.
            _inFlight = null;
        }

        private static bool IsStationary(Container container)
        {
            if (!container || container.m_wagon || container.GetComponentInParent<Vagon>() || container.GetComponentInParent<Ship>() || container.GetComponentInParent<ZSyncTransform>() || container.GetComponentInParent<TombStone>()) return false;
            return true;
        }

        private void BuildPrefabCatalog()
        {
            if (!ZNetScene.instance) return;
            foreach (var prefab in ZNetScene.instance.m_prefabs)
            {
                if (!prefab) continue;
                var container = prefab.GetComponentInChildren<Container>(true);
                if (!IsStationary(container)) continue;
                _prefabs[prefab.name.GetStableHashCode()] = new PrefabInfo { Name = prefab.name, DisplayName = Localize(container.m_name) };
            }
        }

        internal void Track(Container container)
        {
            if (_worldId == null || !IsStationary(container)) return;
            var inventory = container.GetInventory();
            var view = container.m_rootObjectOverride ? container.m_rootObjectOverride : container.GetComponent<ZNetView>();
            if (inventory == null || !view || view.GetZDO() == null || _tracked.ContainsKey(inventory)) return;
            var entry = new Tracked { Container = container, View = view };
            entry.OnChanged = () => _dirty.Add(inventory);
            inventory.m_onChanged += entry.OnChanged;
            _tracked[inventory] = entry;
            _dirty.Add(inventory);
        }

        private void Discover()
        {
            BuildPrefabCatalog();
            foreach (var container in UnityEngine.Object.FindObjectsByType<Container>(FindObjectsSortMode.None)) Track(container);
            foreach (var pair in _tracked.ToArray())
            {
                if (pair.Value.Container && pair.Value.View && pair.Value.View.GetZDO() != null) continue;
                pair.Key.m_onChanged -= pair.Value.OnChanged;
                _tracked.Remove(pair.Key); _dirty.Remove(pair.Key);
                // Unity unload is not destruction. The backend retains last known state.
            }
        }

        private void CaptureDirty()
        {
            foreach (var inventory in _dirty.ToArray())
                if (_tracked.TryGetValue(inventory, out var entry)) ObserveLoadedSafely(inventory, entry);
            _dirty.Clear();
        }

        private void ObserveLoadedSafely(Inventory inventory, Tracked entry)
        {
            try { ObserveLoaded(inventory, entry); }
            catch (Exception ex)
            {
                if (_decodeWarnings++ < 8) Logger.LogWarning("Preserving old state: a loaded container could not be read (" + ex.Message + ").");
            }
        }

        private void ObserveLoaded(Inventory inventory, Tracked entry)
        {
            if (!entry.Container || !entry.View || entry.View.GetZDO() == null) return;
            var zdo = entry.View.GetZDO();
            // Awake creates an empty Inventory before native CheckForChanges performs the first Load.
            // Only expose the inventory after vanilla has loaded/saved this exact revision.
            if ((uint)_lastRevisionField.GetValue(entry.Container) != zdo.DataRevision) return;
            if (!_prefabs.TryGetValue(zdo.GetPrefab(), out var prefab))
            {
                var original = ZNetScene.instance.GetPrefab(zdo.GetPrefab());
                if (!original) return;
                prefab = new PrefabInfo { Name = original.name, DisplayName = Localize(entry.Container.m_name) };
            }
            var items = new List<ItemRecord>();
            foreach (var item in inventory.GetAllItems())
            {
                if (item == null || item.m_stack <= 0) continue;
                if (item.m_shared == null) throw new InvalidOperationException("item metadata unavailable");
                var itemPrefab = item.m_dropPrefab;
                string name = itemPrefab ? itemPrefab.name : "unknown:" + item.m_shared.m_name;
                items.Add(new ItemRecord { prefab = name, name = Localize(item.m_shared.m_name), quantity = item.m_stack });
            }
            Queue(zdo, prefab, Aggregate(items));
        }

        private void BeginPersistedScan()
        {
            _nextScan = Time.realtimeSinceStartup + 20f;
            if (_sectorsField == null || _sectorsField.FieldType != typeof(List<ZDO>[])) return;
            _sectors = _sectorsField.GetValue(_manager) as List<ZDO>[];
            _sectorIndex = _objectIndex = 0; _scanned.Clear();
        }

        private void ScanBudget()
        {
            if (_sectors == null) return;
            var timer = Stopwatch.StartNew(); int visited = 0;
            while (_sectorIndex < _sectors.Length && visited < 4000 && timer.Elapsed.TotalMilliseconds < 1.0)
            {
                var list = _sectors[_sectorIndex];
                if (list == null || _objectIndex >= list.Count) { _sectorIndex++; _objectIndex = 0; continue; }
                var zdo = list[_objectIndex++]; visited++;
                if (zdo == null || !zdo.IsValid() || !_prefabs.TryGetValue(zdo.GetPrefab(), out var prefab)) continue;
                string id = zdo.m_uid.ToString();
                if (!_scanned.Add(id)) continue;
                // Prefer the same-frame live Inventory over serialized data for loaded containers.
                bool loaded = _tracked.Values.Any(t => t.View && t.View.GetZDO() == zdo);
                if (loaded) continue;
                var bytes = zdo.GetByteArray(ZDOVars.s_items);
                if (bytes == null) continue; // Unknown/uninitialized is not an empty chest.
                try { Queue(zdo, prefab, ReadSerializedItems(bytes)); }
                catch (Exception ex)
                {
                    if (_decodeWarnings++ < 8) Logger.LogWarning("Preserving old state: inventory for " + id + " could not be read (" + ex.Message + ").");
                }
            }
            if (_sectorIndex >= _sectors.Length)
            {
                Logger.LogDebug("Read-only persisted scan completed; recognized " + _scanned.Count + " stationary container ZDOs; coverage remains partial.");
                _sectors = null; _scanned.Clear();
            }
        }

        private static List<ItemRecord> ReadSerializedItems(byte[] bytes)
        {
            var pkg = new ZPackage(bytes);
            int version = pkg.ReadInt();
            if (version < 108 || version > 110) throw new InvalidOperationException("unsupported item format " + version);
            int count = pkg.ReadUShort();
            if (count > 4096) throw new InvalidOperationException("inventory exceeds read-only decoding budget");
            var items = new List<ItemRecord>();
            for (int i = 0; i < count; i++)
            {
                var decoded = ItemDrop.ItemData.Load(pkg, (global::Version.Item)version);
                var prefab = ObjectDB.instance ? ObjectDB.instance.GetItemPrefab(decoded.prefabHash) : null;
                var drop = prefab ? prefab.GetComponent<ItemDrop>() : null;
                string key = prefab ? prefab.name : "hash:" + decoded.prefabHash.ToString(CultureInfo.InvariantCulture);
                if (decoded.itemData.m_stack > 0) items.Add(new ItemRecord { prefab = key, name = drop ? Localize(drop.m_itemData.m_shared.m_name) : key, quantity = decoded.itemData.m_stack });
            }
            return Aggregate(items);
        }

        private static List<ItemRecord> Aggregate(IEnumerable<ItemRecord> items)
        {
            return items.GroupBy(i => i.prefab, StringComparer.Ordinal).Select(g => new ItemRecord { prefab = g.Key, name = g.First().name, quantity = g.Sum(i => i.quantity) }).OrderBy(i => i.prefab, StringComparer.Ordinal).ToList();
        }

        private void Queue(ZDO zdo, PrefabInfo prefab, List<ItemRecord> items)
        {
            var position = zdo.GetPosition();
            string id = zdo.m_uid.ToString();
            var record = new ContainerRecord { id = id, identityKey = Identity(zdo.GetPrefab(), position), type = prefab.Name, name = prefab.DisplayName, x = position.x, y = position.y, z = position.z, items = items, observedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) };
            _pending[id] = record; _destroyed.Remove(id); _observedIds.Add(id);
        }

        private static string FloatBits(float value) => unchecked((uint)BitConverter.ToInt32(BitConverter.GetBytes(value), 0)).ToString("x8", CultureInfo.InvariantCulture);
        private static string Identity(int prefabHash, Vector3 p) => "pos-v1:" + prefabHash.ToString(CultureInfo.InvariantCulture) + ":" + FloatBits(p.x) + ":" + FloatBits(p.y) + ":" + FloatBits(p.z);
        private static string Localize(string text) => Localization.instance != null ? Localization.instance.Localize(text ?? "") : text ?? "";

        private void OnZdoDestroyed(ZDO zdo)
        {
            if (zdo == null) return;
            string id = zdo.m_uid.ToString();
            if (!_observedIds.Contains(id)) return;
            _pending.Remove(id); _destroyed.Add(id); _observedIds.Remove(id);
            // This callback is from HandleDestroyedZDO, not scene unloading or view destruction.
        }

        private void PumpSender(float now)
        {
            if (_sendTask != null)
            {
                if (!_sendTask.IsCompleted) return;
                bool success = _sendTask.Status == TaskStatus.RanToCompletion && _sendTask.Result;
                _sendTask = null;
                if (success) { _inFlight = null; _warnedSend = false; }
                else
                {
                    _nextRetry = now + 3f;
                    if (!_warnedSend) { Logger.LogWarning("Local backend unavailable or token rejected. Keeping queued observations and retrying; game continues normally."); _warnedSend = true; }
                }
            }
            if (now < _nextRetry || string.IsNullOrWhiteSpace(_token.Value)) return;
            if (!Uri.TryCreate(_endpoint.Value, UriKind.Absolute, out var endpoint) || endpoint.Scheme != "http" || !endpoint.IsLoopback)
            { if (!_warnedSend) Logger.LogError("Export disabled: Endpoint must be loopback HTTP."); _warnedSend = true; return; }
            if (_inFlight == null)
            {
                if (_pending.Count == 0 && _destroyed.Count == 0 && now < _lastSentAt + 3f) return;
                var batch = _pending.Values.Take(300).ToArray();
                var destroyed = _destroyed.Take(1000).ToArray();
                var payload = new { sourceId = _sourceId.Value, worldId = _worldId, worldName = _worldName, mode = _mode, sessionId = _sessionId, sequence = ++_sequence, containers = batch, destroyedIds = destroyed, coverage = "partial", gameVersion = _gameVersion };
                _inFlight = JsonConvert.SerializeObject(payload);
                foreach (var item in batch) _pending.Remove(item.id);
                foreach (var id in destroyed) _destroyed.Remove(id);
            }
            string body = _inFlight, token = _token.Value, url = endpoint.AbsoluteUri;
            _lastSentAt = now;
            _sendTask = Task.Run(async () =>
            {
                try
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Post, url))
                    {
                        request.Headers.Add("X-VRM-Token", token);
                        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                        using (var response = await Http.SendAsync(request).ConfigureAwait(false)) return response.IsSuccessStatusCode;
                    }
                }
                catch { return false; }
            });
        }
        private float _lastSentAt = -3f;

        private void OnDestroy()
        {
            ResetWorld(); _harmony?.UnpatchSelf();
            if (Instance == this) Instance = null;
        }

        [HarmonyPatch(typeof(Container), "Awake")]
        private static class ContainerAwakePatch
        {
            private static void Postfix(Container __instance)
            {
                try { Instance?.Track(__instance); }
                catch (Exception ex) { Instance?.Logger.LogDebug("Deferred container discovery: " + ex.Message); }
            }
        }

        [Serializable] private sealed class ItemRecord { public string prefab, name; public int quantity; }
        [Serializable] private sealed class ContainerRecord { public string id, identityKey, type, name, observedAt; public float x, y, z; public List<ItemRecord> items; }
    }
}
