import { describe, it, expect } from 'vitest';






function generateYaml({ platform, browserName, screenResolution, region, tunnelName, suiteName }) {
  const tunnelSection = tunnelName ?
  `  tunnel:\n    name: "${tunnelName}"\n` :
  '';

  return `apiVersion: v1alpha
kind: playwright
sauce:
  region: ${region}
  concurrency: 1
${tunnelSection}
playwright:
  version: 1.52.0

suites:
  - name: "${suiteName}"
    platformName: "${platform}"
    screenResolution: "${screenResolution}"
    params:
      browserName: "${browserName}"
      headless: false
    testMatch: ["tests/extract.spec.js"]

artifacts:
  download:
    when: always
    match: ["extraction-result.json", "screenshots-manifest.json", "keyframe-*.jpg"]
    directory: ./artifacts/
`;
}

describe('YAML generation', () => {
  it('produces valid apiVersion and kind', () => {
    const yaml = generateYaml({
      platform: 'Windows 11',
      browserName: 'chromium',
      screenResolution: '1920x1080',
      region: 'us-west-1',
      tunnelName: null,
      suiteName: 'extract-abc12345'
    });

    expect(yaml).toContain('apiVersion: v1alpha');
    expect(yaml).toContain('kind: playwright');
  });

  it('includes correct platform, browser, and resolution', () => {
    const yaml = generateYaml({
      platform: 'macOS 13',
      browserName: 'webkit',
      screenResolution: '2560x1440',
      region: 'eu-central-1',
      tunnelName: null,
      suiteName: 'extract-test'
    });

    expect(yaml).toContain('platformName: "macOS 13"');
    expect(yaml).toContain('browserName: "webkit"');
    expect(yaml).toContain('screenResolution: "2560x1440"');
    expect(yaml).toContain('region: eu-central-1');
  });

  it('includes tunnel section when tunnelName is provided', () => {
    const yaml = generateYaml({
      platform: 'Windows 10',
      browserName: 'firefox',
      screenResolution: '1920x1080',
      region: 'us-west-1',
      tunnelName: 'my-tunnel',
      suiteName: 'extract-def'
    });

    expect(yaml).toContain('tunnel:');
    expect(yaml).toContain('name: "my-tunnel"');
  });

  it('omits tunnel section when tunnelName is null', () => {
    const yaml = generateYaml({
      platform: 'Windows 11',
      browserName: 'chromium',
      screenResolution: '1920x1080',
      region: 'us-west-1',
      tunnelName: null,
      suiteName: 'extract-abc'
    });

    expect(yaml).not.toContain('tunnel:');
  });

  it('includes artifacts download configuration', () => {
    const yaml = generateYaml({
      platform: 'Windows 11',
      browserName: 'chromium',
      screenResolution: '1920x1080',
      region: 'us-west-1',
      tunnelName: null,
      suiteName: 'test'
    });

    expect(yaml).toContain('artifacts:');
    expect(yaml).toContain('extraction-result.json');
    expect(yaml).toContain('screenshots-manifest.json');
    expect(yaml).toContain('keyframe-*.jpg');
  });

  it('sets Playwright version to 1.52.0', () => {
    const yaml = generateYaml({
      platform: 'Windows 11',
      browserName: 'chromium',
      screenResolution: '1920x1080',
      region: 'us-west-1',
      tunnelName: null,
      suiteName: 'test'
    });

    expect(yaml).toContain('version: 1.52.0');
  });

  it('sets concurrency to 1', () => {
    const yaml = generateYaml({
      platform: 'Windows 11',
      browserName: 'chromium',
      screenResolution: '1920x1080',
      region: 'us-west-1',
      tunnelName: null,
      suiteName: 'test'
    });

    expect(yaml).toContain('concurrency: 1');
  });

  it('references the correct test file', () => {
    const yaml = generateYaml({
      platform: 'Windows 11',
      browserName: 'chromium',
      screenResolution: '1920x1080',
      region: 'us-west-1',
      tunnelName: null,
      suiteName: 'test'
    });

    expect(yaml).toContain('testMatch: ["tests/extract.spec.js"]');
  });

  it('never contains credential values or access key patterns', () => {
    const fakeAccessKey = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const yaml = generateYaml({
      platform: 'Windows 11',
      browserName: 'chromium',
      screenResolution: '1920x1080',
      region: 'us-west-1',
      tunnelName: null,
      suiteName: 'test'
    });

    expect(yaml).not.toContain(fakeAccessKey);
    expect(yaml).not.toMatch(/SAUCE_ACCESS_KEY/);
    expect(yaml).not.toMatch(/access_key/i);
    expect(yaml).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
  });
});