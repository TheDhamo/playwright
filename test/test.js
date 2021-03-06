/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const fs = require('fs');
const utils = require('./utils');
const TestRunner = require('../utils/testrunner/');
const {Environment} = require('../utils/testrunner/Test');
const { DispatcherScope } = require('../lib/rpc/dispatcher');
const { Connection } = require('../lib/rpc/connection');
const { helper } = require('../lib/helper');
const { BrowserTypeDispatcher } = require('../lib/rpc/server/browserTypeDispatcher');

function getCLIArgument(argName) {
  for (let i = 0; i < process.argv.length; ++i) {
    // Support `./test.js --foo bar
    if (process.argv[i] === argName)
      return process.argv[i + 1];
    // Support `./test.js --foo=bar
    if (argName.startsWith('--') && process.argv[i].startsWith(argName + '='))
      return process.argv[i].substring((argName + '=').length);
    // Support `./test.js -j4
    if (!argName.startsWith('--') && argName.startsWith('-') && process.argv[i].startsWith(argName))
      return process.argv[i].substring(argName.length);
  }
  return null;
}

function collect(browserNames) {
  let parallel = 1;
  if (process.env.PW_PARALLEL_TESTS)
    parallel = parseInt(process.env.PW_PARALLEL_TESTS.trim(), 10);
  if (getCLIArgument('-j'))
    parallel = parseInt(getCLIArgument('-j'), 10);
  require('events').defaultMaxListeners *= parallel;

  let timeout = process.env.CI ? 30 * 1000 : 10 * 1000;
  if (!isNaN(process.env.TIMEOUT))
    timeout = parseInt(process.env.TIMEOUT * 1000, 10);
  const MAJOR_NODEJS_VERSION = parseInt(process.version.substring(1).split('.')[0], 10);
  if (MAJOR_NODEJS_VERSION >= 8 && require('inspector').url()) {
    console.log('Detected inspector - disabling timeout to be debugger-friendly');
    timeout = 0;
  }

  const config = require('./test.config');

  const testRunner = new TestRunner({
    timeout,
    totalTimeout: process.env.CI ? 30 * 60 * 1000 * browserNames.length : 0, // 30 minutes per browser on CI
    parallel,
    breakOnFailure: process.argv.indexOf('--break-on-failure') !== -1,
    verbose: process.argv.includes('--verbose'),
    summary: !process.argv.includes('--verbose'),
    showSlowTests: process.env.CI ? 5 : 0,
    showMarkedAsFailingTests: 10,
    lineBreak: parseInt(getCLIArgument('--line-break') || 0, 10),
  });
  if (config.setupTestRunner)
    config.setupTestRunner(testRunner);

  for (const [key, value] of Object.entries(testRunner.api()))
    global[key] = value;

  // TODO: this should be a preinstalled playwright by default.
  const playwrightPath = config.playwrightPath;
  const playwright = require('..');
  const { setUnderTest } = require(require('path').join(playwrightPath, 'lib/helper.js'));
  setUnderTest();

  const playwrightEnvironment = new Environment('Playwright');
  playwrightEnvironment.beforeAll(async state => {
    state.playwright = playwright;
  });
  playwrightEnvironment.afterAll(async state => {
    delete state.playwright;
  });

  testRunner.collector().useEnvironment(playwrightEnvironment);
  for (const e of config.globalEnvironments || [])
    testRunner.collector().useEnvironment(e);

  global.playwright = playwright;

  for (const browserName of browserNames) {
    const browserType = playwright[browserName];

    const browserTypeEnvironment = new Environment('BrowserType');
    browserTypeEnvironment.beforeAll(async state => {
      // Channel substitute
      let overridenBrowserType = browserType;
      if (process.env.PWCHANNEL) {
        const dispatcherScope = new DispatcherScope();
        const connection = new Connection();
        dispatcherScope.onmessage = async message => {
          setImmediate(() => connection.send(message));
        };
        connection.onmessage = async message => {
          const result = await dispatcherScope.send(message);
          await new Promise(f => setImmediate(f));
          return result;
        };
        BrowserTypeDispatcher.from(dispatcherScope, browserType);
        overridenBrowserType = await connection.waitForObjectWithKnownName(browserType.name());
      }
      state.browserType = overridenBrowserType;
    });
    browserTypeEnvironment.afterAll(async state => {
      delete state.browserType;
    });

    // TODO: maybe launch options per browser?
    const launchOptions = {
      ...(config.launchOptions || {}),
      handleSIGINT: false,
    };
    if (launchOptions.executablePath)
      launchOptions.executablePath = launchOptions.executablePath[browserName];
    if (launchOptions.executablePath) {
      const YELLOW_COLOR = '\x1b[33m';
      const RESET_COLOR = '\x1b[0m';
      console.warn(`${YELLOW_COLOR}WARN: running ${browserName} tests with ${launchOptions.executablePath}${RESET_COLOR}`);
      browserType._executablePath = launchOptions.executablePath;
      delete launchOptions.executablePath;
    } else {
      if (!fs.existsSync(browserType.executablePath()))
        throw new Error(`Browser is not downloaded. Run 'npm install' and try to re-run tests`);
    }

    const browserEnvironment = new Environment(browserName);
    browserEnvironment.beforeAll(async state => {
      state._logger = utils.createTestLogger(config.dumpLogOnFailure);
      state.browser = await state.browserType.launch({...launchOptions, logger: state._logger});
    });
    browserEnvironment.afterAll(async state => {
      await state.browser.close();
      delete state.browser;
      delete state._logger;
    });
    browserEnvironment.beforeEach(async(state, testRun) => {
      state._logger.setTestRun(testRun);
    });
    browserEnvironment.afterEach(async (state, testRun) => {
      state._logger.setTestRun(null);
    });

    const pageEnvironment = new Environment('Page');
    pageEnvironment.beforeEach(async state => {
      state.context = await state.browser.newContext();
      state.page = await state.context.newPage();
    });
    pageEnvironment.afterEach(async state => {
      await state.context.close();
      state.context = null;
      state.page = null;
    });

    const suiteName = { 'chromium': 'Chromium', 'firefox': 'Firefox', 'webkit': 'WebKit' }[browserName];
    describe(suiteName, () => {
      // In addition to state, expose these two on global so that describes can access them.
      global.browserType = browserType;
      global.HEADLESS = !!launchOptions.headless;

      testRunner.collector().useEnvironment(browserTypeEnvironment);

      for (const spec of config.specs || []) {
        const skip = spec.browsers && !spec.browsers.includes(browserName);
        (skip ? xdescribe : describe)(spec.title || '', () => {
          for (const e of spec.environments || ['page']) {
            if (e === 'browser') {
              testRunner.collector().useEnvironment(browserEnvironment);
            } else if (e === 'page') {
              testRunner.collector().useEnvironment(browserEnvironment);
              testRunner.collector().useEnvironment(pageEnvironment);
            } else {
              testRunner.collector().useEnvironment(e);
            }
          }
          for (const file of spec.files || []) {
            require(file);
            delete require.cache[require.resolve(file)];
          }
        });
      }

      delete global.HEADLESS;
      delete global.browserType;
    });
  }
  for (const [key, value] of Object.entries(testRunner.api())) {
    // expect is used when running tests, while the rest of api is not.
    if (key !== 'expect')
      delete global[key];
  }

  return testRunner;
}

module.exports = collect;

if (require.main === module) {
  console.log('Testing on Node', process.version);
  const browserNames = ['chromium', 'firefox', 'webkit'].filter(name => {
    return process.env.BROWSER === name || process.env.BROWSER === 'all';
  });
  const testRunner = collect(browserNames);

  const testNameFilter = getCLIArgument('--filter');
  if (testNameFilter && !testRunner.focusMatchingNameTests(new RegExp(testNameFilter, 'i')).length) {
    console.log('ERROR: no tests matched given `--filter` regex.');
    process.exit(1);
  }

  const fileNameFilter = getCLIArgument('--file');
  if (fileNameFilter && !testRunner.focusMatchingFileName(new RegExp(fileNameFilter, 'i')).length) {
    console.log('ERROR: no files matched given `--file` regex.');
    process.exit(1);
  }

  const repeat = parseInt(getCLIArgument('--repeat'), 10);
  if (!isNaN(repeat))
    testRunner.repeatAll(repeat);

  testRunner.run().then(() => { delete global.expect; });
}
