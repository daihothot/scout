using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEngine;

namespace Scout.UnityPipeline.PrefixPatch
{
    /// <summary>
    /// Applies the approved macOS HttpListener prefix compatibility patch after validating
    /// the Pipeline package version, source signature, and request security guards.
    /// </summary>
    [InitializeOnLoad]
    internal static class PipelinePrefixPatch
    {
        private const string PackageName = "com.unity.pipeline";
        private const string SupportedPackageVersion = "0.4.0-exp.1";
        private const string OldPrefix = "listener.Prefixes.Add($\"http://+:{port}/\");";
        private const string NewPrefix = "listener.Prefixes.Add($\"http://*:{port}/\");";
        private const string LoopbackGuard = "IPAddress.IsLoopback(remoteAddress)";
        private const string OriginGuard = "request.Headers[\"Origin\"]";
        private const string AuthorizationGuard = "IsAuthorized(request)";
        private const string BearerGuard = "Bearer ";

        [Serializable]
        private sealed class PackageManifest
        {
            public string name;
            public string version;
        }

        static PipelinePrefixPatch()
        {
            EditorApplication.delayCall += TryPatchAndReload;
        }

        private static void TryPatchAndReload()
        {
            try
            {
                var projectRoot = Directory.GetParent(Application.dataPath)?.FullName;
                if (string.IsNullOrEmpty(projectRoot))
                    return;

                var cacheRoot = Path.GetFullPath(
                    Path.Combine(projectRoot, "Library", "PackageCache"));
                var matchingPackages = PackageInfo.GetAllRegisteredPackages()
                    .Where(package => package.name == PackageName)
                    .ToArray();
                if (matchingPackages.Length != 1)
                {
                    Debug.LogError(
                        $"[PipelinePrefixPatch] Refused: expected one active {PackageName} package, found {matchingPackages.Length}.");
                    return;
                }

                var package = matchingPackages[0];
                if (package.version != SupportedPackageVersion)
                {
                    Debug.LogError(
                        $"[PipelinePrefixPatch] Refused: unsupported {PackageName} version {package.version}.");
                    return;
                }

                var packageRoot = Path.GetFullPath(package.resolvedPath);
                if (!packageRoot.StartsWith(
                        cacheRoot + Path.DirectorySeparatorChar,
                        StringComparison.Ordinal))
                {
                    Debug.LogError(
                        $"[PipelinePrefixPatch] Refused: active package is outside Library/PackageCache: {packageRoot}");
                    return;
                }

                var manifest = ReadManifest(packageRoot);
                if (manifest == null ||
                    manifest.name != PackageName ||
                    manifest.version != SupportedPackageVersion)
                {
                    Debug.LogError(
                        $"[PipelinePrefixPatch] Refused: package manifest does not match {PackageName}@{SupportedPackageVersion}.");
                    return;
                }

                var sourcePath = Path.Combine(
                    packageRoot,
                    "Runtime",
                    "Common",
                    "BasePipelineServer.cs");
                if (!File.Exists(sourcePath))
                {
                    Debug.LogError(
                        $"[PipelinePrefixPatch] Refused: source file missing for {PackageName}@{SupportedPackageVersion}.");
                    return;
                }

                var source = File.ReadAllText(sourcePath);
                var oldPrefixCount = CountOccurrences(source, OldPrefix);
                var newPrefixCount = CountOccurrences(source, NewPrefix);

                if (newPrefixCount == 1 && oldPrefixCount == 0)
                {
                    if (!HasRequiredSecurityGuards(source))
                    {
                        Debug.LogError(
                            $"[PipelinePrefixPatch] Refused: patched source is missing required security guards: {sourcePath}");
                    }
                    return;
                }

                if (oldPrefixCount != 1 || newPrefixCount != 0)
                {
                    Debug.LogError(
                        $"[PipelinePrefixPatch] Refused: unexpected prefix source signature: {sourcePath}");
                    return;
                }

                if (!HasRequiredSecurityGuards(source))
                {
                    Debug.LogError(
                        $"[PipelinePrefixPatch] Refused: source is missing required security guards: {sourcePath}");
                    return;
                }

                File.WriteAllText(sourcePath, source.Replace(OldPrefix, NewPrefix));
                Debug.Log(
                    $"[PipelinePrefixPatch] Patched HttpListener prefix + -> * in {sourcePath}");
                EditorUtility.RequestScriptReload();
            }
            catch (Exception exception)
            {
                Debug.LogError(
                    $"[PipelinePrefixPatch] Refused: patch operation failed. {exception.Message}");
            }
        }

        private static PackageManifest ReadManifest(string packageRoot)
        {
            var manifestPath = Path.Combine(packageRoot, "package.json");
            if (!File.Exists(manifestPath))
                return null;

            try
            {
                return JsonUtility.FromJson<PackageManifest>(File.ReadAllText(manifestPath));
            }
            catch (Exception exception)
            {
                Debug.LogError(
                    $"[PipelinePrefixPatch] Refused: failed to read package manifest {manifestPath}. {exception.Message}");
                return null;
            }
        }

        private static bool HasRequiredSecurityGuards(string source)
        {
            return source.Contains(LoopbackGuard) &&
                   source.Contains(OriginGuard) &&
                   source.Contains(AuthorizationGuard) &&
                   source.Contains(BearerGuard);
        }

        private static int CountOccurrences(string source, string value)
        {
            var count = 0;
            var index = 0;
            while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
            {
                count++;
                index += value.Length;
            }

            return count;
        }
    }
}
