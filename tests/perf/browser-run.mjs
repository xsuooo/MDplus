import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable =
  'D:\\Program Files\\npm-global\\node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe';

async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let sequence = 0;
  const fail = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      fail(error);
      socket.close();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => fail(new Error('Performance CDP connection closed')));
  socket.addEventListener('error', () => fail(new Error('Performance CDP connection failed')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Performance CDP connection timed out'));
    }, 15000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Performance CDP connection failed'));
      },
      { once: true },
    );
  });
  return {
    send(method, params = {}, sessionId) {
      assert.equal(socket.readyState, WebSocket.OPEN, 'CDP socket is not open');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Performance CDP request timed out: ${method}`));
        }, 60000);
        pending.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() {
      fail(new Error('Performance CDP connection disposed'));
      socket.close();
    },
  };
}

/** Use only a fresh headless session and generated local fixtures, never a user's browser profile. */
export async function browserMeasurements({ url, evidence, fixtureNames, repetitions, root }) {
  const destination = new URL(url);
  assert.equal(destination.protocol, 'http:');
  assert.equal(destination.hostname, '127.0.0.1');
  assert.equal(destination.pathname, '/tests/perf/index.html');
  assert(Number.isInteger(repetitions) && repetitions > 0);
  assert(fixtureNames.length > 0 && fixtureNames.every((name) => /^[a-z0-9-]+$/.test(name)));
  assert.equal(new Set(fixtureNames).size, fixtureNames.length);
  assert(isAbsolute(root) && isAbsolute(evidence));
  const withinRuns = relative(resolve(root, 'tests/perf/.runs'), resolve(evidence));
  assert(!isAbsolute(withinRuns) && withinRuns !== '..' && !withinRuns.startsWith(`..${sep}`));
  await mkdir(evidence, { recursive: true });
  const session = `mdplus-perf-${randomUUID().replaceAll('-', '')}`;
  const config = join(evidence, 'agent-browser.config.json');
  await writeFile(config, '{}\n');
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('AGENT_BROWSER_')),
  );
  await writeFile(
    join(evidence, 'browser-session.json'),
    JSON.stringify({ session, executable, headless: true, userProfile: false }, null, 2),
  );

  async function cli(label, args) {
    const stdoutPath = join(evidence, `browser-${label}.stdout.log`);
    const stderrPath = join(evidence, `browser-${label}.stderr.log`);
    const stdout = await open(stdoutPath, 'w');
    const stderr = await open(stderrPath, 'w');
    try {
      // A daemon can inherit stdio. File handles avoid waiting forever for inherited pipes.
      const child = spawn(
        executable,
        ['--session', session, '--config', config, '--headed', 'false', '--json', ...args],
        { cwd: root, windowsHide: true, env: environment, stdio: ['ignore', stdout.fd, stderr.fd] },
      );
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`agent-browser ${label} timed out; stopped only its CLI process`));
        }, 45000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      const output = await readFile(stdoutPath, 'utf8');
      assert.equal(
        code,
        0,
        `agent-browser ${label} failed: ${(await readFile(stderrPath, 'utf8')).slice(-3000)}`,
      );
      if (label === 'version') {
        assert(/^agent-browser \d+\./.test(output.trim()), 'agent-browser version is missing');
        return output.trim();
      }
      const response = JSON.parse(output);
      assert.equal(response.success, true, `agent-browser ${label}: ${output.slice(-3000)}`);
      return response.data;
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }
  }

  let connection;
  let failure;
  let result;
  try {
    const agentBrowserVersion = await cli('version', ['--version']);
    await cli('open', ['open', 'about:blank']);
    const data = await cli('cdp-url', ['get', 'cdp-url']);
    const endpoints = Object.values(data).filter(
      (value) => typeof value === 'string' && value.startsWith('ws://'),
    );
    assert.equal(endpoints.length, 1, 'agent-browser did not return one CDP WebSocket URL');
    const endpoint = new URL(endpoints[0]);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'CDP must be local');
    connection = await connect(endpoint.href);
    const browser = {
      ...(await connection.send('Browser.getVersion')),
      driver: { name: 'agent-browser', version: agentBrowserVersion, executable },
    };
    assert(browser.userAgent.includes('HeadlessChrome/'), 'Performance browser must be headless');
    const { targetInfos } = await connection.send('Target.getTargets');
    const targets = targetInfos.filter(
      (target) => target.type === 'page' && target.url === 'about:blank',
    );
    assert.equal(targets.length, 1, 'Expected one fresh blank page in the isolated session');
    const { sessionId } = await connection.send('Target.attachToTarget', {
      targetId: targets[0].targetId,
      flatten: true,
    });
    const page = (method, params) => connection.send(method, params, sessionId);
    const evaluate = async (expression) => {
      const response = await page('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 60000,
      });
      if (response.exceptionDetails)
        throw new Error(
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
        );
      return response.result.value;
    };
    await page('Page.enable');
    await page('Runtime.enable');
    const samples = [];
    for (let repetition = -1; repetition < repetitions; repetition++) {
      for (const name of fixtureNames) {
        const fixtureUrl = new URL(url);
        fixtureUrl.searchParams.set('fixture', name);
        fixtureUrl.searchParams.set('repetition', String(repetition));
        const navigation = await page('Page.navigate', { url: fixtureUrl.href });
        assert(!navigation.errorText, `Fixture navigation failed: ${navigation.errorText}`);
        await page('Emulation.setDeviceMetricsOverride', {
          width: 1200,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page('Page.bringToFront');
        await page('Emulation.setFocusEmulationEnabled', { enabled: true });
        const deadline = Date.now() + 60000;
        while (true) {
          try {
            if (
              await evaluate(
                `location.href === ${JSON.stringify(fixtureUrl.href)} && window.perfReady === true`,
              )
            )
              break;
          } catch (error) {
            if (!/Execution context was destroyed|Cannot find.*context/.test(error.message))
              throw error;
          }
          assert(Date.now() < deadline, `Fixture module did not become ready: ${name}`);
          await delay(100);
        }
        await page('HeapProfiler.collectGarbage');
        const initialHeap = await page('Runtime.getHeapUsage');
        const captureProfile = (name === 'long-5000' || name === 'table-1200') && repetition === 0;
        if (captureProfile) {
          await page('Profiler.enable');
          await page('Profiler.start');
        }
        await evaluate(`window.perfHarness.open(${JSON.stringify(name)})`);
        if (captureProfile) {
          const { profile } = await page('Profiler.stop');
          await writeFile(join(evidence, `profile-${name}.json`), JSON.stringify(profile));
        }
        await evaluate('window.perfHarness.prepareInput()');
        for (let index = 0; index < 20; index++) {
          await page('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'x',
            code: 'KeyX',
            windowsVirtualKeyCode: 88,
            nativeVirtualKeyCode: 88,
            text: 'x',
            unmodifiedText: 'x',
          });
          await page('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'x',
            code: 'KeyX',
            windowsVirtualKeyCode: 88,
            nativeVirtualKeyCode: 88,
          });
          await evaluate(`window.perfHarness.waitForInput(${index + 1})`);
        }
        const result = await evaluate('window.perfHarness.finish()');
        assert.equal(result.fixture, name);
        assert.equal(result.inputToFrameMs.length, 20);
        assert.equal(result.longTaskSupported, true, 'Long Task API is unavailable');
        for (const check of ['content', 'undo', 'redo', 'structure'])
          assert.equal(result.assertions[check], true, `Fixture assertion failed: ${check}`);
        const heapBeforeGC = await page('Runtime.getHeapUsage');
        await page('HeapProfiler.collectGarbage');
        const heap = await page('Runtime.getHeapUsage');
        if (repetition >= 0)
          samples.push({
            repetition,
            ...result,
            initialHeapBytes: initialHeap.usedSize,
            heapBeforeGCBytes: heapBeforeGC.usedSize,
            retainedHeapBytes: heap.usedSize,
          });
        console.log(`[perf] browser ${name} ${repetition < 0 ? 'warmup' : repetition + 1}: passed`);
      }
    }
    assert.equal(samples.length, repetitions * fixtureNames.length);
    result = { browser, samples };
    await writeFile(join(evidence, 'browser.json'), JSON.stringify(result, null, 2));
  } catch (error) {
    failure = error;
  } finally {
    connection?.close();
    try {
      await cli('close', ['close']);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Browser measurement and cleanup failed', {
            cause: failure,
          })
        : error;
    }
  }
  if (failure) throw failure;
  return result;
}
