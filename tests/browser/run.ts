import { runAppSafetyRegression, safetyCases, type SafetyCase } from './appSafety';
import { runEditorSyncRegression } from './editorSync';
import { mermaidCases, runMermaidCommitRegression, type MermaidCase } from './mermaidCommit';
import { markdownCases, runMarkdownRoundtrip, type MarkdownCase } from './markdownRoundtrip';

const testCase = new URLSearchParams(location.search).get('case') ?? 'editor-sync';
const result = document.createElement('pre');
result.id = 'regression-result';
result.dataset.status = 'running';
document.body.append(result);
try {
  if (testCase === 'editor-sync') {
    result.textContent = JSON.stringify(await runEditorSyncRegression());
  } else if (markdownCases.includes(testCase as MarkdownCase)) {
    result.textContent = await runMarkdownRoundtrip(testCase as MarkdownCase);
  } else if (mermaidCases.includes(testCase as MermaidCase)) {
    result.textContent = await runMermaidCommitRegression(testCase as MermaidCase);
  } else if (safetyCases.includes(testCase as SafetyCase)) {
    result.textContent = await runAppSafetyRegression(testCase as SafetyCase);
  } else {
    throw new Error(`Unknown regression case: ${testCase}`);
  }
  result.dataset.status = 'passed';
} catch (error) {
  result.dataset.status = 'failed';
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
}
