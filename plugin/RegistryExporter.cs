using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine;

namespace ValheimResourceManager
{
    public sealed partial class Plugin
    {
        private Coroutine _registryCoroutine;
        private bool _registryRequested;
        private float _nextRegistryProbe, _nextRegistryRetry;
        private string _registryFingerprint;
        private readonly HashSet<string> _registryPrefabs = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> _registryUnknown = new HashSet<string>(StringComparer.Ordinal);
        private RegistryExport _registryExport;
        private RegistryExport _registrySendingExport;
        private Task<RegistryUpload.Result> _registrySend;
        // Registry uploads can span slow local disk/registry reloads. Keep their deadline
        // separate from the short inventory heartbeat deadline.
        private static readonly HttpClient RegistryHttp = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(10) };
        private bool _registryWarned;
        private int _registryGeneration;
        private const int IconByteLimit = 512 * 1024, TotalIconByteLimit = 64 * 1024 * 1024;

        private sealed class RegistryExport
        {
            public string Body;
            public Dictionary<string, byte[]> Icons;
        }
        private sealed class RegistryItem
        {
            public string id, prefab, nameRu, nameEn, subcategory, iconKey;
            public int prefabHash, maxStack;
            public object source;
            public Dictionary<string, object> metadata;
            public List<string> diagnostics = new List<string>();
        }

        private void RequestRegistryScan()
        {
            _registryRequested = true;
            _nextRegistryProbe = Time.realtimeSinceStartup + 5f; // Let normal mod initialization finish.
        }

        private void CancelRegistryScan()
        {
            if (_registryCoroutine != null) { StopCoroutine(_registryCoroutine); _registryCoroutine = null; }
            _registryRequested = false; _registryFingerprint = null; _registryExport = null;
            _registryPrefabs.Clear(); _registryUnknown.Clear();
            _registryGeneration++;
            // The in-flight immutable HTTP body can finish; it contains no world/player data.
        }

        private void CheckRegistryItem(string prefab)
        {
            if (!_registryPrefabs.Contains(prefab) && _registryUnknown.Add(prefab))
            {
                _registryRequested = true;
                _nextRegistryProbe = Math.Max(_nextRegistryProbe, Time.realtimeSinceStartup + 5f);
            }
        }

        private void PumpRegistry(float now)
        {
            PumpRegistrySender(now);
            if (_registryCoroutine != null || now < _nextRegistryProbe || !ObjectDB.instance || ObjectDB.instance.m_items.Count == 0) return;
            _nextRegistryProbe = now + 30f;
            string fingerprint = RegistryFingerprint(ObjectDB.instance);
            if (!_registryRequested && fingerprint == _registryFingerprint) return;
            _registryRequested = false;
            _registryCoroutine = StartCoroutine(RunRegistry(BuildRegistry(ObjectDB.instance, fingerprint, _registryGeneration)));
        }

        private IEnumerator RunRegistry(IEnumerator scan)
        {
            while (true)
            {
                object current = null; bool moved;
                try { moved = scan.MoveNext(); if (moved) current = scan.Current; }
                catch (Exception ex)
                {
                    Logger.LogWarning("Registry scan skipped safely: " + ex.GetType().Name + ": " + ex.Message + ". Previous backend registry retained; will retry.");
                    _registryCoroutine = null;
                    yield break;
                }
                if (!moved) { _registryCoroutine = null; yield break; }
                yield return current;
            }
        }

        private static string RegistryFingerprint(ObjectDB db)
        {
            unchecked
            {
                int hash = 17;
                foreach (var prefab in db.m_items)
                {
                    hash = hash * 31 + (prefab ? prefab.GetInstanceID() : 0);
                    if (!prefab) continue;
                    hash = hash * 31 + prefab.name.GetStableHashCode();
                    var shared = prefab.GetComponent<ItemDrop>()?.m_itemData?.m_shared;
                    if (shared == null) continue;
                    hash = hash * 31 + (shared.m_name ?? "").GetStableHashCode();
                    hash = hash * 31 + shared.m_maxStackSize;
                    hash = hash * 31 + shared.m_maxQuality;
                    hash = hash * 31 + shared.m_variants;
                    foreach (var icon in shared.m_icons ?? Array.Empty<Sprite>()) hash = hash * 31 + (icon ? icon.GetInstanceID() : 0);
                }
                var localization = typeof(Localization).GetField("m_instance", BindingFlags.Static | BindingFlags.NonPublic)?.GetValue(null) as Localization;
                if (localization != null) hash = hash * 31 + localization.GetSelectedLanguage().GetStableHashCode();
                return db.GetInstanceID() + ":" + db.m_items.Count + ":" + hash;
            }
        }

        private IEnumerator BuildRegistry(ObjectDB db, string fingerprint, int generation)
        {
            // Snapshot references only. We never instantiate prefabs or invoke ItemDrop.Awake.
            GameObject[] definitions = db.m_items.ToArray();
            var ru = new Dictionary<string, string>(StringComparer.Ordinal);
            var en = new Dictionary<string, string>(StringComparer.Ordinal);
            var csvKeys = new HashSet<string>(StringComparer.Ordinal);
            string localizationStatus = "game-csv";
            var settingsField = typeof(Localization).GetField("m_localizationSettings", BindingFlags.Static | BindingFlags.NonPublic);
            var settings = settingsField?.GetValue(null) as LocalizationSettings;
            if (!settings) settings = Resources.Load<LocalizationSettings>("LocalizationSettings");
            if (settings && settings.Localizations != null)
            {
                foreach (var asset in settings.Localizations)
                {
                    if (!asset) continue;
                    int ruColumn = -1, enColumn = -1, rowIndex = 0;
                    foreach (var row in RegistryAlgorithms.CsvRows(asset.text))
                    {
                        if (rowIndex == 0) { ruColumn = row.FindIndex(c => c == "Russian"); enColumn = row.FindIndex(c => c == "English"); }
                        else if (row.Count > 0 && row[0].Length > 0 && !row[0].StartsWith("//", StringComparison.Ordinal))
                        {
                            csvKeys.Add(row[0]);
                            // Missing RU remains explicitly missing; never silently label an EN fallback as Russian.
                            if (ruColumn >= 0 && row.Count > ruColumn && !string.IsNullOrWhiteSpace(row[ruColumn])) ru[row[0]] = row[ruColumn].Trim();
                            else ru.Remove(row[0]);
                            if (enColumn >= 0 && row.Count > enColumn && !string.IsNullOrWhiteSpace(row[enColumn])) en[row[0]] = row[enColumn].Trim();
                            else en.Remove(row[0]);
                        }
                        rowIndex++;
                        if (rowIndex % 200 == 0) yield return null;
                    }
                    yield return null;
                }
            }
            else localizationStatus = "settings-unavailable";
            // Current-language additions from mods are read, not modified. Other languages may
            // remain missing when a mod only registers the active language at runtime.
            // Do not call the instance getter: it can initialize global localization and
            // startup preferences if the game has not initialized it yet.
            var localization = typeof(Localization).GetField("m_instance", BindingFlags.Static | BindingFlags.NonPublic)?.GetValue(null) as Localization;
            var translationsField = typeof(Localization).GetField("m_translations", BindingFlags.Instance | BindingFlags.NonPublic);
            var translations = localization != null ? translationsField?.GetValue(localization) as Dictionary<string, string> : null;
            if (translations != null)
            {
                string selected = localization.GetSelectedLanguage();
                var destination = selected == "Russian" ? ru : selected == "English" ? en : null;
                if (destination != null) foreach (var pair in translations)
                    if (destination.ContainsKey(pair.Key) || !csvKeys.Contains(pair.Key)) destination[pair.Key] = pair.Value;
            }

            var entries = new List<RegistryItem>();
            var icons = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            var spriteKeys = new Dictionary<int, string>();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var hashes = new Dictionary<int, string>();
            var known = new HashSet<string>(StringComparer.Ordinal);
            int recognized = 0, invalid = 0, duplicates = 0, collisions = 0, variantsFound = 0, variantsExported = 0, iconBytes = 0;
            foreach (var prefab in definitions)
            {
                if (generation != _registryGeneration || !db || db != ObjectDB.instance) { _registryCoroutine = null; yield break; }
                if (!prefab) { invalid++; yield return null; continue; }
                var shared = prefab.GetComponent<ItemDrop>()?.m_itemData?.m_shared;
                if (shared == null) { invalid++; yield return null; continue; }
                recognized++;
                string name = prefab.name, id = "prefab:" + name;
                if (!ids.Add(id)) { duplicates++; yield return null; continue; }
                int hash = name.GetStableHashCode();
                var entry = new RegistryItem
                {
                    id = id, prefab = name, prefabHash = hash, maxStack = shared.m_maxStackSize,
                    subcategory = shared.m_itemType.ToString(),
                    nameRu = ResolveName(shared.m_name, ru), nameEn = ResolveName(shared.m_name, en),
                    source = new { kind = "runtime-objectdb", registry = "ObjectDB.m_items/ItemDrop.m_itemData.m_shared", mod = "UNKNOWN" },
                    metadata = new Dictionary<string, object>
                    {
                        ["localizationKey"] = shared.m_name, ["localizationSource"] = localizationStatus,
                        ["itemType"] = shared.m_itemType.ToString(), ["itemTypeValue"] = (int)shared.m_itemType,
                        ["maxQuality"] = shared.m_maxQuality, ["variants"] = shared.m_variants,
                        ["teleportable"] = shared.m_teleportable, ["questItem"] = shared.m_questItem,
                        ["weight"] = shared.m_weight, ["value"] = shared.m_value, ["food"] = shared.m_food,
                        ["foodStamina"] = shared.m_foodStamina, ["foodEitr"] = shared.m_foodEitr,
                        ["isDrink"] = shared.m_isDrink, ["buildPieces"] = shared.m_buildPieces != null,
                        ["modAttribution"] = "UNKNOWN", ["iconExtraction"] = "original-sprite-mesh-uv-rgba-png"
                    }
                };
                if (entry.nameRu == null) entry.diagnostics.Add("MISSING_LOCALIZATION:ru");
                if (entry.nameEn == null) entry.diagnostics.Add("MISSING_LOCALIZATION:en");
                if (hashes.TryGetValue(hash, out var previous) && previous != name)
                { entry.diagnostics.Add("PREFAB_HASH_COLLISION:" + previous); collisions++; }
                else hashes[hash] = name;
                // The exact prefab string remains the identity even in a stable-hash collision.
                var sprites = shared.m_icons ?? Array.Empty<Sprite>();
                var variantKeys = new string[sprites.Length];
                for (int variant = 0; variant < sprites.Length; variant++)
                {
                    variantsFound++;
                    var sprite = sprites[variant];
                    if (!sprite) entry.diagnostics.Add("MISSING_ICON:variant:" + variant);
                    else
                    {
                        try
                        {
                            if (!spriteKeys.TryGetValue(sprite.GetInstanceID(), out var key))
                            {
                                byte[] png = ExportSprite(sprite);
                                if (png.Length > IconByteLimit) throw new InvalidOperationException("PNG exceeds 512 KiB upload limit");
                                using (var sha = SHA256.Create()) key = BitConverter.ToString(sha.ComputeHash(png)).Replace("-", "").ToLowerInvariant();
                                if (!icons.ContainsKey(key))
                                {
                                    if (iconBytes + png.Length > TotalIconByteLimit) throw new InvalidOperationException("64 MiB per-scan icon budget reached");
                                    icons.Add(key, png); iconBytes += png.Length;
                                }
                                spriteKeys[sprite.GetInstanceID()] = key;
                            }
                            variantKeys[variant] = key; variantsExported++;
                        }
                        catch (Exception ex) { entry.diagnostics.Add("MISSING_ICON:variant:" + variant + ":" + ex.GetType().Name + ":" + ex.Message); }
                    }
                    // GPU readback/PNG encoding is main-thread only, never more than one sprite/frame.
                    yield return null;
                }
                entry.iconKey = variantKeys.Length > 0 ? variantKeys[0] : null;
                entry.metadata["iconVariantKeys"] = variantKeys;
                if (entry.iconKey == null) entry.diagnostics.Add("MISSING_ICON");
                entries.Add(entry); known.Add(name);
                yield return null;
            }
            var payload = new
            {
                schemaVersion = 1, gameVersion = _gameVersion,
                source = new { kind = "runtime-objectdb", exporter = "ValheimResourceManager/0.2.0", context = "loaded-world", assetsPublished = false },
                generatedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture), items = entries,
                coverage = new
                {
                    definitionsFound = definitions.Length, registered = entries.Count, scope = "runtime-objectdb", runtimeVerified = true,
                    recognizedItemDrops = recognized, invalidObjectDbEntries = invalid, duplicateIds = duplicates,
                    hashCollisions = collisions, itemsWithIcons = entries.Count(i => i.iconKey != null),
                    iconVariantsFound = variantsFound, iconVariantsExported = variantsExported,
                    complete = entries.Count == definitions.Length && invalid == 0 && duplicates == 0,
                    limitations = new[] { "Only the current loaded ObjectDB is observed.", "Mod ownership is UNKNOWN unless a provider reports it.", "Container/world coverage remains partial and independent of catalog coverage." }
                }
            };
            string body = JsonConvert.SerializeObject(payload, new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore });
            if (Encoding.UTF8.GetByteCount(body) <= 3 * 1024 * 1024)
            {
                _registryExport = new RegistryExport { Body = body, Icons = icons };
                _registryFingerprint = fingerprint; _registryPrefabs.Clear();
                foreach (string name in known) { _registryPrefabs.Add(name); _registryUnknown.Remove(name); }
                _nextRegistryRetry = 0;
                Logger.LogInfo("Runtime item registry captured: " + entries.Count + "/" + definitions.Length + " ObjectDB entries, " + icons.Count + " authentic PNGs, " + collisions + " hash collisions. Awaiting authenticated backend readback; world coverage remains partial.");
            }
            else Logger.LogWarning("Runtime item registry exceeds 3 MiB transport limit; retaining previous backend catalog. No catalog-completeness claim is made.");
            _registryCoroutine = null;
        }

        private static string ResolveName(string token, Dictionary<string, string> dictionary)
        {
            if (string.IsNullOrWhiteSpace(token)) return null;
            if (!token.StartsWith("$", StringComparison.Ordinal)) return token;
            return dictionary.TryGetValue(token.Substring(1), out string value) ? value : null;
        }

        private static byte[] ExportSprite(Sprite sprite)
        {
            var texture = sprite.texture;
            if (!texture) throw new InvalidOperationException("Sprite texture unavailable");
            int width = Mathf.RoundToInt(sprite.rect.width), height = Mathf.RoundToInt(sprite.rect.height);
            if (width < 1 || height < 1 || width > 512 || height > 512) throw new InvalidOperationException("Original sprite canvas outside 1..512 pixel safety budget");
            Vector2[] vertices = sprite.vertices, uv = sprite.uv;
            ushort[] triangles = sprite.triangles;
            if (vertices.Length == 0 || vertices.Length != uv.Length || triangles.Length == 0) throw new InvalidOperationException("Sprite mesh unavailable");
            int x0 = Math.Max(0, (int)Math.Floor(uv.Min(p => p.x) * texture.width));
            int y0 = Math.Max(0, (int)Math.Floor(uv.Min(p => p.y) * texture.height));
            int x1 = Math.Min(texture.width, (int)Math.Ceiling(uv.Max(p => p.x) * texture.width));
            int y1 = Math.Min(texture.height, (int)Math.Ceiling(uv.Max(p => p.y) * texture.height));
            int cropWidth = x1 - x0, cropHeight = y1 - y0;
            if (cropWidth < 1 || cropHeight < 1 || cropWidth > 1024 || cropHeight > 1024) throw new InvalidOperationException("Sprite atlas crop outside safety budget");
            RenderTexture render = null; Texture2D readable = null, output = null;
            var oldActive = RenderTexture.active;
            try
            {
                // Read back only the atlas area used by the sprite. The source texture may be
                // non-readable; it is never modified, reimported or made readable in place.
                render = RenderTexture.GetTemporary(cropWidth, cropHeight, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Default);
                Graphics.Blit(texture, render,
                    new Vector2((float)cropWidth / texture.width, (float)cropHeight / texture.height),
                    new Vector2((float)x0 / texture.width, (float)y0 / texture.height));
                RenderTexture.active = render;
                readable = new Texture2D(cropWidth, cropHeight, TextureFormat.RGBA32, false);
                readable.ReadPixels(new Rect(0, 0, cropWidth, cropHeight), 0, 0, false);
                readable.Apply(false, false);
                var colors = readable.GetPixels32(); var packed = new uint[colors.Length];
                for (int i = 0; i < colors.Length; i++) packed[i] = (uint)(colors[i].r | colors[i].g << 8 | colors[i].b << 16 | colors[i].a << 24);
                var canvas = new RegistryAlgorithms.Point[vertices.Length]; var source = new RegistryAlgorithms.Point[uv.Length];
                for (int i = 0; i < vertices.Length; i++)
                {
                    canvas[i] = new RegistryAlgorithms.Point(vertices[i].x * sprite.pixelsPerUnit + sprite.pivot.x, vertices[i].y * sprite.pixelsPerUnit + sprite.pivot.y);
                    source[i] = new RegistryAlgorithms.Point(uv[i].x * texture.width, uv[i].y * texture.height);
                }
                uint[] pixels = RegistryAlgorithms.Rasterize(width, height, canvas, source, triangles, packed, cropWidth, cropHeight, x0, y0);
                var result = new Color32[pixels.Length];
                for (int i = 0; i < pixels.Length; i++) result[i] = new Color32((byte)pixels[i], (byte)(pixels[i] >> 8), (byte)(pixels[i] >> 16), (byte)(pixels[i] >> 24));
                output = new Texture2D(width, height, TextureFormat.RGBA32, false);
                output.SetPixels32(result); output.Apply(false, false);
                return ImageConversion.EncodeToPNG(output);
            }
            finally
            {
                RenderTexture.active = oldActive;
                if (render) RenderTexture.ReleaseTemporary(render);
                if (readable) UnityEngine.Object.Destroy(readable);
                if (output) UnityEngine.Object.Destroy(output);
            }
        }

        private void PumpRegistrySender(float now)
        {
            if (_registrySend != null)
            {
                if (!_registrySend.IsCompleted) return;
                bool success = _registrySend.Status == TaskStatus.RanToCompletion && _registrySend.Result.Success;
                string failure = _registrySend.Status == TaskStatus.RanToCompletion ? _registrySend.Result.FailureCode : "TASK_" + _registrySend.Status;
                _registrySend = null;
                bool newerExportReady = _registryExport != _registrySendingExport;
                _registrySendingExport = null;
                if (success) { _registryWarned = false; _nextRegistryRetry = now + 300f; }
                else
                {
                    _nextRegistryRetry = now + 30f;
                    if (!_registryWarned) { Logger.LogWarning("Registry/icon upload incomplete (" + failure + "). Previous backend registry retained; retrying separately from inventory synchronization."); _registryWarned = true; }
                }
                if (newerExportReady) _nextRegistryRetry = 0;
            }
            if (_registryExport == null || now < _nextRegistryRetry || string.IsNullOrWhiteSpace(_token.Value)) return;
            if (!Uri.TryCreate(_endpoint.Value, UriKind.Absolute, out var endpoint) || endpoint.Scheme != "http" || !endpoint.IsLoopback) return;
            // Capture immutable data/config before leaving the Unity main thread.
            var export = _registryExport; string token = _token.Value;
            _registrySendingExport = export;
            var registryUri = new Uri(endpoint, "/api/registry");
            var iconBase = new Uri(endpoint, "/api/icons/");
            _nextRegistryRetry = now + 30f;
            _registrySend = Task.Run(() => RegistryUpload.PublishAsync(export.Icons,
                (key, bytes) => PostExport(new Uri(iconBase, key + ".png"), token, bytes, "image/png"),
                () => PostExport(registryUri, token, Encoding.UTF8.GetBytes(export.Body), "application/json")));
        }

        private static async Task<string> PostExport(Uri uri, string token, byte[] bytes, string contentType)
        {
            try
            {
                using (var request = new HttpRequestMessage(HttpMethod.Post, uri))
                {
                    request.Headers.Add("X-VRM-Token", token);
                    request.Content = new ByteArrayContent(bytes);
                    request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
                    using (var response = await RegistryHttp.SendAsync(request).ConfigureAwait(false))
                        return response.IsSuccessStatusCode ? null : "HTTP_" + (int)response.StatusCode;
                }
            }
            catch (TaskCanceledException) { return "REQUEST_TIMEOUT"; }
            catch (Exception ex) { return ex.GetType().Name; }
        }
    }
}
