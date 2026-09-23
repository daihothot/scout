using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace AppPilot.UnityTools
{
    public static class AppPilotUnityBuild
    {
        private const string AppleDeveloperTeamId = "39253T242A";
        private const string IosProvisioningProfileId = "74e6cf5f-6c57-4fd6-8664-04d69f9fc95d";
        private const ProvisioningProfileType IosProvisioningProfileType = ProvisioningProfileType.Development;
        private const string GuruKeystoreName = "guru_key.jks";
        private const string GuruKeystorePass = "guru0622";
        private const string GuruAliasName = "guru";
        private const string GuruAliasPass = "guru0622";

        public static void BuildIOSDevice()
        {
            var outputPath = ReadOption("-apppilotOutputPath");
            if (string.IsNullOrEmpty(outputPath))
            {
                Debug.LogError("Missing -apppilotOutputPath.");
                EditorApplication.Exit(1);
                return;
            }

            var configuration = ReadOption("-apppilotConfiguration") ?? "debug";
            var isDebug = string.Equals(configuration, "debug", StringComparison.OrdinalIgnoreCase);
            var append = string.Equals(ReadOption("-apppilotAppend"), "true", StringComparison.OrdinalIgnoreCase);

            var previousTarget = EditorUserBuildSettings.activeBuildTarget;
            var previousGroup = BuildPipeline.GetBuildTargetGroup(previousTarget);
            var previousDevelopment = EditorUserBuildSettings.development;
            var previousAllowDebugging = EditorUserBuildSettings.allowDebugging;
            var previousConnectProfiler = EditorUserBuildSettings.connectProfiler;
            var previousBuildScriptsOnly = EditorUserBuildSettings.buildScriptsOnly;
            var previousSdkVersion = PlayerSettings.iOS.sdkVersion;
            var previousTargetDevice = PlayerSettings.iOS.targetDevice;
            var previousAutomaticSigning = PlayerSettings.iOS.appleEnableAutomaticSigning;
            var previousDeveloperTeamId = PlayerSettings.iOS.appleDeveloperTeamID;
            var previousProvisioningProfileId = PlayerSettings.iOS.iOSManualProvisioningProfileID;
            var previousProvisioningProfileType = PlayerSettings.iOS.iOSManualProvisioningProfileType;

            try
            {
                Directory.CreateDirectory(outputPath);

                if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.iOS)
                {
                    EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.iOS, BuildTarget.iOS);
                }

                EditorUserBuildSettings.development = isDebug;
                EditorUserBuildSettings.allowDebugging = isDebug;
                EditorUserBuildSettings.connectProfiler = false;
                EditorUserBuildSettings.buildScriptsOnly = false;

                PlayerSettings.muteOtherAudioSources = false;
                PlayerSettings.iOS.appInBackgroundBehavior = iOSAppInBackgroundBehavior.Custom;
                PlayerSettings.iOS.backgroundModes = iOSBackgroundMode.RemoteNotification | iOSBackgroundMode.Fetch;
                PlayerSettings.iOS.sdkVersion = iOSSdkVersion.DeviceSDK;
                PlayerSettings.iOS.targetDevice = iOSTargetDevice.iPhoneAndiPad;
                PlayerSettings.iOS.appleEnableAutomaticSigning = false;
                PlayerSettings.iOS.appleDeveloperTeamID = AppleDeveloperTeamId;
                PlayerSettings.iOS.iOSManualProvisioningProfileID = IosProvisioningProfileId;
                PlayerSettings.iOS.iOSManualProvisioningProfileType = IosProvisioningProfileType;

                var buildOptions = isDebug ? BuildOptions.Development | BuildOptions.AllowDebugging : BuildOptions.None;
                if (append)
                {
                    buildOptions |= BuildOptions.AcceptExternalModificationsToPlayer;
                }

                var options = new BuildPlayerOptions
                {
                    scenes = EditorBuildSettings.scenes
                        .Where(scene => scene.enabled)
                        .Select(scene => scene.path)
                        .ToArray(),
                    locationPathName = outputPath,
                    target = BuildTarget.iOS,
                    targetGroup = BuildTargetGroup.iOS,
                    options = buildOptions,
                };

                Debug.Log($"[AppPilot] Build iOS device Xcode project: {outputPath}, append={append}");
                var report = BuildPipeline.BuildPlayer(options);
                if (report.summary.result != BuildResult.Succeeded)
                {
                    Debug.LogError($"[AppPilot] Build failed: {report.summary.result}");
                    EditorApplication.Exit(1);
                    return;
                }

                Debug.Log($"[AppPilot] Build succeeded: {report.summary.outputPath}");
                EditorApplication.Exit(0);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                EditorApplication.Exit(1);
            }
            finally
            {
                PlayerSettings.iOS.sdkVersion = previousSdkVersion;
                PlayerSettings.iOS.targetDevice = previousTargetDevice;
                PlayerSettings.iOS.appleEnableAutomaticSigning = previousAutomaticSigning;
                PlayerSettings.iOS.appleDeveloperTeamID = previousDeveloperTeamId;
                PlayerSettings.iOS.iOSManualProvisioningProfileID = previousProvisioningProfileId;
                PlayerSettings.iOS.iOSManualProvisioningProfileType = previousProvisioningProfileType;
                EditorUserBuildSettings.development = previousDevelopment;
                EditorUserBuildSettings.allowDebugging = previousAllowDebugging;
                EditorUserBuildSettings.connectProfiler = previousConnectProfiler;
                EditorUserBuildSettings.buildScriptsOnly = previousBuildScriptsOnly;

                if (previousTarget != BuildTarget.iOS)
                {
                    EditorUserBuildSettings.SwitchActiveBuildTarget(previousGroup, previousTarget);
                }

                AssetDatabase.SaveAssets();
            }
        }

        public static void BuildAndroidDevice()
        {
            var outputPath = ReadOption("-apppilotOutputPath");
            if (string.IsNullOrEmpty(outputPath))
            {
                Debug.LogError("Missing -apppilotOutputPath.");
                EditorApplication.Exit(1);
                return;
            }

            var configuration = ReadOption("-apppilotConfiguration") ?? "debug";
            var isDebug = string.Equals(configuration, "debug", StringComparison.OrdinalIgnoreCase);

            var previousTarget = EditorUserBuildSettings.activeBuildTarget;
            var previousGroup = BuildPipeline.GetBuildTargetGroup(previousTarget);
            var previousDevelopment = EditorUserBuildSettings.development;
            var previousAllowDebugging = EditorUserBuildSettings.allowDebugging;
            var previousConnectProfiler = EditorUserBuildSettings.connectProfiler;
            var previousBuildScriptsOnly = EditorUserBuildSettings.buildScriptsOnly;
            var previousExportProject = EditorUserBuildSettings.exportAsGoogleAndroidProject;
            var previousBuildAppBundle = EditorUserBuildSettings.buildAppBundle;
            var previousUseCustomKeystore = PlayerSettings.Android.useCustomKeystore;
            var previousKeystoreName = PlayerSettings.Android.keystoreName;
            var previousKeystorePass = PlayerSettings.Android.keystorePass;
            var previousKeyaliasName = PlayerSettings.Android.keyaliasName;
            var previousKeyaliasPass = PlayerSettings.Android.keyaliasPass;

            try
            {
                var outputDir = Path.GetDirectoryName(outputPath);
                if (!string.IsNullOrEmpty(outputDir))
                {
                    Directory.CreateDirectory(outputDir);
                }

                if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android)
                {
                    EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);
                }

                EditorUserBuildSettings.development = isDebug;
                EditorUserBuildSettings.allowDebugging = isDebug;
                EditorUserBuildSettings.connectProfiler = false;
                EditorUserBuildSettings.buildScriptsOnly = false;
                EditorUserBuildSettings.exportAsGoogleAndroidProject = false;
                EditorUserBuildSettings.buildAppBundle = false;
                PlayerSettings.Android.useCustomKeystore = true;
                PlayerSettings.Android.keystoreName = Path.Combine(Application.dataPath, "Plugins", "Android", GuruKeystoreName);
                PlayerSettings.Android.keystorePass = GuruKeystorePass;
                PlayerSettings.Android.keyaliasName = GuruAliasName;
                PlayerSettings.Android.keyaliasPass = GuruAliasPass;

                var buildOptions = isDebug ? BuildOptions.Development | BuildOptions.AllowDebugging : BuildOptions.None;
                var options = new BuildPlayerOptions
                {
                    scenes = EditorBuildSettings.scenes
                        .Where(scene => scene.enabled)
                        .Select(scene => scene.path)
                        .ToArray(),
                    locationPathName = outputPath,
                    target = BuildTarget.Android,
                    targetGroup = BuildTargetGroup.Android,
                    options = buildOptions,
                };

                Debug.Log($"[AppPilot] Build Android APK: {outputPath}");
                var report = BuildPipeline.BuildPlayer(options);
                if (report.summary.result != BuildResult.Succeeded)
                {
                    Debug.LogError($"[AppPilot] Build failed: {report.summary.result}");
                    EditorApplication.Exit(1);
                    return;
                }

                Debug.Log($"[AppPilot] Build succeeded: {report.summary.outputPath}");
                EditorApplication.Exit(0);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                EditorApplication.Exit(1);
            }
            finally
            {
                EditorUserBuildSettings.development = previousDevelopment;
                EditorUserBuildSettings.allowDebugging = previousAllowDebugging;
                EditorUserBuildSettings.connectProfiler = previousConnectProfiler;
                EditorUserBuildSettings.buildScriptsOnly = previousBuildScriptsOnly;
                EditorUserBuildSettings.exportAsGoogleAndroidProject = previousExportProject;
                EditorUserBuildSettings.buildAppBundle = previousBuildAppBundle;
                PlayerSettings.Android.useCustomKeystore = previousUseCustomKeystore;
                PlayerSettings.Android.keystoreName = previousKeystoreName;
                PlayerSettings.Android.keystorePass = previousKeystorePass;
                PlayerSettings.Android.keyaliasName = previousKeyaliasName;
                PlayerSettings.Android.keyaliasPass = previousKeyaliasPass;

                if (previousTarget != BuildTarget.Android)
                {
                    EditorUserBuildSettings.SwitchActiveBuildTarget(previousGroup, previousTarget);
                }

                AssetDatabase.SaveAssets();
            }
        }

        private static string ReadOption(string name)
        {
            var args = Environment.GetCommandLineArgs();
            for (var i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == name)
                {
                    return args[i + 1];
                }
            }

            return null;
        }
    }
}
