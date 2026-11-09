import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { experimental_getRunnerTask, type Reporter } from 'vitest/node';

// Vitest 4.1's built-in outputJson clears samples even with includeSamples enabled.
const samplesReporter: Reporter = {
  onTestRunEnd(modules) {
    const metrics = modules.flatMap((module) =>
      [...module.children.allTests()].flatMap((test) => {
        const result = experimental_getRunnerTask(test).result?.benchmark;
        if (!result?.samples.length || test.parent.type !== 'suite') return [];
        const fixture = test.parent.name.split(' / ')[0];
        const operation = test.name.split(' / ')[0];
        return [{ name: `frontend/${operation}/${fixture}`, unit: 'ms', samples: result.samples }];
      }),
    );
    console.log(
      `MDPLUS_PERF_FRONTEND=${JSON.stringify({
        metrics,
        scope: [
          'Node/jsdom frontend regression; excludes native blocking, layout, and input latency.',
          '50 measured iterations and 10 warmup iterations; setup and edits are outside timings.',
          'Image collection uses a real cache and current source plus 20 history versions; native image IPC is mocked.',
        ],
      })}`,
    );
  },
};

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  define: { __MDPLUS_BUILD_ID__: JSON.stringify('performance-regression') },
  test: {
    environment: 'jsdom',
    fileParallelism: false,
    maxWorkers: 1,
    benchmark: {
      include: ['tests/perf/frontend.bench.ts'],
      includeSamples: true,
      reporters: ['default', samplesReporter],
    },
  },
});
