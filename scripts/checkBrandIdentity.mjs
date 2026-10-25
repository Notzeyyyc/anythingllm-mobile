import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('--- Checking Brand Identity ---');

// 1. app.json
const appJsonPath = path.join(rootDir, 'app.json');
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
assert.equal(appJson.name, 'AnythingPocket', 'app.json name must be AnythingPocket');
assert.equal(appJson.displayName, 'AnythingPocket', 'app.json displayName must be AnythingPocket');
console.log('✓ app.json name & displayName is AnythingPocket');

// 2. MainActivity.kt getMainComponentName()
const mainActivityPath = path.join(rootDir, 'android/app/src/main/java/com/anythingpocket/MainActivity.kt');
const mainActivityContent = fs.readFileSync(mainActivityPath, 'utf8');
const mainActivityMatch = mainActivityContent.match(/override\s+fun\s+getMainComponentName\(\):\s*String\s*=\s*"([^"]+)"/);
assert(mainActivityMatch, 'MainActivity.kt getMainComponentName() not found');
assert.equal(mainActivityMatch[1], 'AnythingPocket', 'MainActivity getMainComponentName must return AnythingPocket');
console.log('✓ MainActivity.kt getMainComponentName() === AnythingPocket');

// 3. AppDelegate.mm moduleName
const appDelegatePath = path.join(rootDir, 'ios/AnythingLLM/AppDelegate.mm');
const appDelegateContent = fs.readFileSync(appDelegatePath, 'utf8');
const appDelegateMatch = appDelegateContent.match(/self\.moduleName\s*=\s*@"([^"]+)";/);
assert(appDelegateMatch, 'AppDelegate.mm moduleName not found');
assert.equal(appDelegateMatch[1], 'AnythingPocket', 'AppDelegate.mm moduleName must be AnythingPocket');
console.log('✓ AppDelegate.mm moduleName === AnythingPocket');

// Component name sync: app.json === MainActivity === AppDelegate
assert.equal(appJson.name, mainActivityMatch[1], 'app.json name must match MainActivity component name');
assert.equal(appJson.name, appDelegateMatch[1], 'app.json name must match AppDelegate moduleName');

// 4. index.js registrations match Kotlin COMPONENT_NAME
const indexJsPath = path.join(rootDir, 'index.js');
const indexJsContent = fs.readFileSync(indexJsPath, 'utf8');
assert(indexJsContent.includes("AppRegistry.registerComponent('AnythingPocketQuickContext'"), 'index.js missing AnythingPocketQuickContext registration');
assert(indexJsContent.includes("AppRegistry.registerComponent('AnythingPocketAssistant'"), 'index.js missing AnythingPocketAssistant registration');

const quickContextPath = path.join(rootDir, 'android/app/src/main/java/com/anythingpocket/quickcontext/QuickContextActivity.kt');
const quickContextContent = fs.readFileSync(quickContextPath, 'utf8');
const quickContextMatch = quickContextContent.match(/const\s+val\s+COMPONENT_NAME\s*=\s*"([^"]+)"/);
assert(quickContextMatch, 'QuickContextActivity COMPONENT_NAME not found');
assert.equal(quickContextMatch[1], 'AnythingPocketQuickContext', 'QuickContextActivity COMPONENT_NAME must be AnythingPocketQuickContext');

const assistantPath = path.join(rootDir, 'android/app/src/main/java/com/anythingpocket/assistant/AssistantActivity.kt');
const assistantContent = fs.readFileSync(assistantPath, 'utf8');
const assistantMatch = assistantContent.match(/const\s+val\s+COMPONENT_NAME\s*=\s*"([^"]+)"/);
assert(assistantMatch, 'AssistantActivity COMPONENT_NAME not found');
assert.equal(assistantMatch[1], 'AnythingPocketAssistant', 'AssistantActivity COMPONENT_NAME must be AnythingPocketAssistant');
console.log('✓ index.js component registrations match Kotlin COMPONENT_NAME constants');

// 5. Android applicationId & namespace in build.gradle
const buildGradlePath = path.join(rootDir, 'android/app/build.gradle');
const buildGradleContent = fs.readFileSync(buildGradlePath, 'utf8');
const namespaceMatch = buildGradleContent.match(/namespace\s+"([^"]+)"/);
const appIdMatch = buildGradleContent.match(/applicationId\s+"([^"]+)"/);
assert(namespaceMatch, 'build.gradle namespace not found');
assert(appIdMatch, 'build.gradle applicationId not found');
assert.equal(namespaceMatch[1], 'com.anythingpocket', 'namespace must be com.anythingpocket');
assert.equal(appIdMatch[1], 'com.anythingpocket', 'applicationId must be com.anythingpocket');
console.log('✓ android/app/build.gradle namespace and applicationId === com.anythingpocket');

// 6. strings.xml app_name
const stringsXmlPath = path.join(rootDir, 'android/app/src/main/res/values/strings.xml');
const stringsXmlContent = fs.readFileSync(stringsXmlPath, 'utf8');
const appNameMatch = stringsXmlContent.match(/<string\s+name="app_name">([^<]+)<\/string>/);
assert(appNameMatch, 'strings.xml app_name not found');
assert.equal(appNameMatch[1], 'AnythingPocket', 'strings.xml app_name must be AnythingPocket');
console.log('✓ strings.xml app_name === AnythingPocket');

// 7. Info.plist CFBundleDisplayName
const infoPlistPath = path.join(rootDir, 'ios/AnythingLLM/Info.plist');
const infoPlistContent = fs.readFileSync(infoPlistPath, 'utf8');
const displayNameMatch = infoPlistContent.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/);
assert(displayNameMatch, 'Info.plist CFBundleDisplayName not found');
assert.equal(displayNameMatch[1], 'AnythingPocket', 'Info.plist CFBundleDisplayName must be AnythingPocket');
console.log('✓ Info.plist CFBundleDisplayName === AnythingPocket');

// 8. ios/AnythingLLM.xcodeproj/project.pbxproj bundle identifier
const pbxprojPath = path.join(rootDir, 'ios/AnythingLLM.xcodeproj/project.pbxproj');
const pbxprojContent = fs.readFileSync(pbxprojPath, 'utf8');
assert(!pbxprojContent.includes('PRODUCT_BUNDLE_IDENTIFIER = ai.AnythingLLM;'), 'pbxproj still contains ai.AnythingLLM');
const appTargetMatches = [...pbxprojContent.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*ai\.([^;]+);/g)];
assert.equal(appTargetMatches.length, 2, 'Expected 2 occurrences of ai.AnythingPocket bundle identifier in pbxproj');
for (const m of appTargetMatches) {
  assert.equal(m[1], 'AnythingPocket', `Bundle identifier must be ai.AnythingPocket, got ${m[1]}`);
}
console.log('✓ pbxproj PRODUCT_BUNDLE_IDENTIFIER === ai.AnythingPocket (2x)');

// 9. Scan for forbidden residual 'com.anythingllm' in android/ and ios/ (excluding build artifacts and autolinking cache)
function checkNoResidualComAnythingLLM(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['build', '.cxx', '.gradle', 'Pods', 'builds', 'DerivedData'].includes(entry.name)) {
        continue;
      }
      checkNoResidualComAnythingLLM(fullPath);
    } else if (entry.isFile()) {
      // Skip binary files
      if (entry.name.endsWith('.keystore') || entry.name.endsWith('.png') || entry.name.endsWith('.ttf') || entry.name.endsWith('.jar')) {
        continue;
      }
      const text = fs.readFileSync(fullPath, 'utf8');
      if (text.includes('com.anythingllm')) {
        throw new Error(`Residual "com.anythingllm" found in file: ${fullPath}`);
      }
    }
  }
}

checkNoResidualComAnythingLLM(path.join(rootDir, 'android'));
checkNoResidualComAnythingLLM(path.join(rootDir, 'ios'));
console.log('✓ No residual com.anythingllm in android/ or ios/');

console.log('--- ALL BRAND IDENTITY CHECKS PASSED (exit 0) ---');
