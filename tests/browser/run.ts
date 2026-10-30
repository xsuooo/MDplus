import { runAppSafetyRegression, safetyCases, type SafetyCase } from './appSafety';
import { runEditorSyncRegression } from './editorSync';
import { mermaidCases, runMermaidCommitRegression, type MermaidCase } from './mermaidCommit';
import { markdownCases, runMarkdownRoundtrip, type MarkdownCase } from './markdownRoundtrip';
import { appearanceCases, runAppearanceRegression, type AppearanceCase } from './appearance';
import { recoveryCases, runRecoveryRegression, type RecoveryCase } from './recovery';
import { continuityCases, runContinuityRegression, type ContinuityCase } from './continuity';
import { typographyCases, runTypographyRegression, type TypographyCase } from './typography';
import { mediaCases, runMediaRegression, type MediaCase } from './media';
import { exportCases, runExportRegression, type ExportCase } from './export';

const testCase = new URLSearchParams(location.search).get('case') ?? 'editor-sync';
const result = document.createElement('pre');
result.id = 'regression-result';
result.dataset.status = 'running';
document.body.append(result);
try {
  if (testCase === 'editor-sync') {
    result.textContent = JSON.stringify(await runEditorSyncRegression());
  } else if (exportCases.includes(testCase as ExportCase)) {
    result.textContent = await runExportRegression(testCase as ExportCase);
  } else if (mediaCases.includes(testCase as MediaCase)) {
    result.textContent = await runMediaRegression(testCase as MediaCase);
  } else if (typographyCases.includes(testCase as TypographyCase)) {
    result.textContent = await runTypographyRegression(testCase as TypographyCase);
  } else if (continuityCases.includes(testCase as ContinuityCase)) {
    result.textContent = await runContinuityRegression(testCase as ContinuityCase);
  } else if (recoveryCases.includes(testCase as RecoveryCase)) {
    result.textContent = await runRecoveryRegression(testCase as RecoveryCase);
  } else if (appearanceCases.includes(testCase as AppearanceCase)) {
    result.textContent = await runAppearanceRegression(testCase as AppearanceCase);
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
