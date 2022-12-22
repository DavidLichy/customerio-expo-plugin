import { ConfigPlugin, withXcodeProject } from '@expo/config-plugins';
import xcode from 'xcode';

import {
  CIO_NOTIFICATION_TARGET_NAME,
  DEFAULT_BUNDLE_VERSION,
  LOCAL_PATH_TO_CIO_NSE_FILES,
} from '../helpers/constants/ios';
import { replaceCodeByRegex } from '../helpers/utils/codeInjection';
import { injectCIONotificationPodfileCode } from '../helpers/utils/injectCIOPodfileCode';
import type { CustomerIOPluginOptionsIOS } from '../types/cio-types';
import { FileManagement } from './../helpers/utils/fileManagement';

const PLIST_FILENAME = `${CIO_NOTIFICATION_TARGET_NAME}-Info.plist`;

const TARGETED_DEVICE_FAMILY = `"1,2"`;

const addNotificationServiceExtension = async (
  options: CustomerIOPluginOptionsIOS
) => {
  // iosPath and appName are predefined from Expo config.
  // See function withCioNotificationsXcodeProject to get where the variabes are pulled from.
  const { iosPath, appName } = options;

  const projPath = `${iosPath}/${appName}.xcodeproj/project.pbxproj`;

  const xcodeProject = xcode.project(projPath);

  xcodeProject.parse(async function (err: Error) {
    if (err) {
      throw new Error(`Error parsing iOS project: ${JSON.stringify(err)}`);
    }

    if (options.pushNotification) {
      await addPushNotificationFile(options, xcodeProject);
    }

    if (options.pushNotification?.useRichPush) {
      await addRichPushXcodeProj(options, xcodeProject);
    }

    FileManagement.writeFile(projPath, xcodeProject.writeSync());
  });
};

export const withCioNotificationsXcodeProject: ConfigPlugin<
  CustomerIOPluginOptionsIOS
> = (configOuter, props) => {
  return withXcodeProject(configOuter, async (config) => {
    const { modRequest, ios, version: bundleShortVersion } = config;
    const {
      appleTeamId,
      iosDeploymentTarget,
      pushNotification,
      useFrameworks,
    } = props;

    if (ios === undefined)
      throw new Error(
        'Adding NotificationServiceExtension failed: ios config missing from app.config.js or app.json.'
      );

    // projectName and platformProjectRoot translates to appName and iosPath in addNotificationServiceExtension()
    const { projectName, platformProjectRoot } = modRequest;
    const { bundleIdentifier, buildNumber } = ios;

    if (bundleShortVersion === undefined) {
      throw new Error(
        'Adding NotificationServiceExtension failed: version missing from app.config.js or app.json'
      );
    }

    if (bundleIdentifier === undefined) {
      throw new Error(
        'Adding NotificationServiceExtension failed: ios.bundleIdentifier missing from app.config.js or app.json'
      );
    }

    if (projectName === undefined) {
      throw new Error(
        'Adding NotificationServiceExtension failed: name missing from app.config.js or app.json'
      );
    }

    const options = {
      appleTeamId,
      bundleIdentifier,
      bundleShortVersion,
      bundleVersion: buildNumber || DEFAULT_BUNDLE_VERSION,
      iosPath: platformProjectRoot,
      appName: projectName,
      useFrameworks,
      iosDeploymentTarget,
      pushNotification,
    };

    await addNotificationServiceExtension(options);

    return config;
  });
};

const addRichPushXcodeProj = async (
  options: CustomerIOPluginOptionsIOS,
  xcodeProject: any
) => {
  const {
    appleTeamId,
    bundleIdentifier,
    bundleShortVersion,
    bundleVersion,
    iosPath,
    iosDeploymentTarget,
    useFrameworks,
  } = options;

  await injectCIONotificationPodfileCode(iosPath, useFrameworks);

  const nsePath = `${iosPath}/${CIO_NOTIFICATION_TARGET_NAME}`;
  FileManagement.mkdir(nsePath, {
    recursive: true,
  });

  const files = [
    PLIST_FILENAME,
    'NotificationService.h',
    'NotificationService.swift',
    'NotificationService.m',
  ];

  const getTargetFile = (filename: string) => `${nsePath}/${filename}`;

  files.forEach((filename) => {
    const targetFile = getTargetFile(filename);
    FileManagement.copyFile(
      `${LOCAL_PATH_TO_CIO_NSE_FILES}/${filename}`,
      targetFile
    );
  });

  /* MODIFY COPIED EXTENSION FILES */
  const infoPlistTargetFile = getTargetFile(PLIST_FILENAME);
  updateNseInfoPlist({
    bundleVersion,
    bundleShortVersion,
    infoPlistTargetFile,
  });

  // Create new PBXGroup for the extension
  const extGroup = xcodeProject.addPbxGroup(
    files,
    CIO_NOTIFICATION_TARGET_NAME,
    CIO_NOTIFICATION_TARGET_NAME
  );

  // Add the new PBXGroup to the top level group. This makes the
  // files / folder appear in the file explorer in Xcode.
  const groups = xcodeProject.hash.project.objects['PBXGroup'];
  Object.keys(groups).forEach((key) => {
    if (groups[key].name === undefined) {
      xcodeProject.addToPbxGroup(extGroup.uuid, key);
    }
  });

  // WORK AROUND for codeProject.addTarget BUG
  // Xcode projects don't contain these if there is only one target
  // An upstream fix should be made to the code referenced in this link:
  //   - https://github.com/apache/cordova-node-xcode/blob/8b98cabc5978359db88dc9ff2d4c015cba40f150/lib/pbxProject.js#L860
  const projObjects = xcodeProject.hash.project.objects;
  projObjects['PBXTargetDependency'] = projObjects['PBXTargetDependency'] || {};
  projObjects['PBXContainerItemProxy'] =
    projObjects['PBXTargetDependency'] || {};

  if (xcodeProject.pbxTargetByName(CIO_NOTIFICATION_TARGET_NAME)) {
    console.warn(
      `${CIO_NOTIFICATION_TARGET_NAME} already exists in project. Skipping...`
    );
    return;
  }

  // Add the NSE target
  // This also adds PBXTargetDependency and PBXContainerItemProxy
  const nseTarget = xcodeProject.addTarget(
    CIO_NOTIFICATION_TARGET_NAME,
    'app_extension',
    CIO_NOTIFICATION_TARGET_NAME,
    `${bundleIdentifier}.richpush`
  );

  // Add build phases to the new target
  xcodeProject.addBuildPhase(
    ['NotificationService.m', 'NotificationService.swift'],
    'PBXSourcesBuildPhase',
    'Sources',
    nseTarget.uuid
  );
  xcodeProject.addBuildPhase(
    [],
    'PBXResourcesBuildPhase',
    'Resources',
    nseTarget.uuid
  );

  xcodeProject.addBuildPhase(
    [],
    'PBXFrameworksBuildPhase',
    'Frameworks',
    nseTarget.uuid
  );

  // Edit the Deployment info of the target
  const configurations = xcodeProject.pbxXCBuildConfigurationSection();
  for (const key in configurations) {
    if (
      typeof configurations[key].buildSettings !== 'undefined' &&
      configurations[key].buildSettings.PRODUCT_NAME ===
        `"${CIO_NOTIFICATION_TARGET_NAME}"`
    ) {
      const buildSettingsObj = configurations[key].buildSettings;
      buildSettingsObj.DEVELOPMENT_TEAM = appleTeamId;
      buildSettingsObj.IPHONEOS_DEPLOYMENT_TARGET =
        iosDeploymentTarget || '13.0';
      buildSettingsObj.TARGETED_DEVICE_FAMILY = TARGETED_DEVICE_FAMILY;
      buildSettingsObj.CODE_SIGN_STYLE = 'Automatic';
      buildSettingsObj.SWIFT_VERSION = 4.2;
    }
  }

  // Add development team to the target & the main
  xcodeProject.addTargetAttribute('DevelopmentTeam', appleTeamId, nseTarget);
  xcodeProject.addTargetAttribute('DevelopmentTeam', appleTeamId);
};

const updateNseInfoPlist = (payload: {
  bundleVersion?: string;
  bundleShortVersion?: string;
  infoPlistTargetFile: string;
}) => {
  const BUNDLE_SHORT_VERSION_RE = /\{\{BUNDLE_SHORT_VERSION\}\}/;
  const BUNDLE_VERSION_RE = /\{\{BUNDLE_VERSION\}\}/;

  let plistFileString = FileManagement.readFile(payload.infoPlistTargetFile);

  if (payload.bundleVersion) {
    plistFileString = replaceCodeByRegex(
      plistFileString,
      BUNDLE_VERSION_RE,
      payload.bundleVersion
    );
  }

  if (payload.bundleShortVersion) {
    plistFileString = replaceCodeByRegex(
      plistFileString,
      BUNDLE_SHORT_VERSION_RE,
      payload.bundleShortVersion
    );
  }

  FileManagement.writeFile(payload.infoPlistTargetFile, plistFileString);
};

async function addPushNotificationFile(
  options: CustomerIOPluginOptionsIOS,
  xcodeProject: any
) {
  const { iosPath, appName } = options;
  const file = 'PushService.swift';
  const appPath = `${iosPath}/${appName}`;
  const getTargetFile = (filename: string) => `${appPath}/${filename}`;

  if (!FileManagement.exists(getTargetFile(file))) {
    FileManagement.mkdir(appPath, {
      recursive: true,
    });

    const targetFile = getTargetFile(file);
    FileManagement.copyFile(
      `${LOCAL_PATH_TO_CIO_NSE_FILES}/${file}`,
      targetFile
    );
  } else {
    console.log(`${getTargetFile(file)} already exists. Skipping...`);
  }

  const group = xcodeProject.pbxCreateGroup('CustomerIONotifications');
  const classesKey = xcodeProject.findPBXGroupKey({ name: `${appName}` });
  xcodeProject.addToPbxGroup(group, classesKey);

  xcodeProject.addSourceFile(`${appName}/${file}`, null, group);
}
