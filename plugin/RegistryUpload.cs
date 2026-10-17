#nullable disable
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace ValheimResourceManager
{
    // Transport-independent ordering contract: a manifest must never refer to an icon
    // that failed to arrive during this upload. Failed scans are retried as a unit.
    public static class RegistryUpload
    {
        public sealed class Result
        {
            public bool Success;
            public int IconsUploaded;
            public string FailureCode;
        }

        // A null failure code means success. Codes contain no response bodies, URLs or tokens.
        public static async Task<Result> PublishAsync(IReadOnlyDictionary<string, byte[]> icons,
            Func<string, byte[], Task<string>> uploadIcon, Func<Task<string>> publishManifest)
        {
            var pending = new Queue<KeyValuePair<string, byte[]>>(icons);
            var result = new Result();
            object gate = new object();
            Func<Task> worker = async () =>
            {
                while (true)
                {
                    KeyValuePair<string, byte[]> icon;
                    lock (gate)
                    {
                        if (result.FailureCode != null || pending.Count == 0) return;
                        icon = pending.Dequeue();
                    }
                    string failure = await uploadIcon(icon.Key, icon.Value).ConfigureAwait(false);
                    lock (gate)
                    {
                        if (failure == null) result.IconsUploaded++;
                        else if (result.FailureCode == null) result.FailureCode = "ICON_" + failure;
                    }
                }
            };
            await Task.WhenAll(worker(), worker()).ConfigureAwait(false);
            if (result.FailureCode != null) return result;
            string manifestFailure = await publishManifest().ConfigureAwait(false);
            result.FailureCode = manifestFailure == null ? null : "MANIFEST_" + manifestFailure;
            result.Success = result.FailureCode == null;
            return result;
        }
    }
}
