import assert from "node:assert/strict";
import {
  saveProjectBackup,
  mergeAutomationScriptsWithBackup,
  mergeScenariosWithBackup,
  mergeRecordedFlowsWithBackup
} from "../services/storageBackupService";

const complete = "export const completeSuite = true;\n".repeat(100);
const file = { path: "tests/all.spec.ts", content: complete };

await saveProjectBackup({
  id: "backup-restore-validation",
  automationScripts: [{
    id: "suite-1",
    title: "Suite",
    tool: "Playwright",
    language: "TypeScript",
    createdAt: new Date().toISOString(),
    content: complete,
    files: [file]
  }]
} as any);

const merged = mergeAutomationScriptsWithBackup("backup-restore-validation", [{
  id: "suite-1",
  title: "Suite",
  tool: "Playwright",
  language: "TypeScript",
  createdAt: new Date().toISOString(),
  content: `${complete.slice(0, 1000)}... [trimmed for Firestore]`,
  files: [{
    path: file.path,
    content: `${complete.slice(0, 1000)}... [trimmed for Firestore]`
  }]
}], new Set());

assert.equal(merged[0].content, complete);
assert.equal(merged[0].files[0].content, complete);
console.log("Full script markdown and source files are restored over Firestore-truncated copies.");

const mergedScenarios = mergeScenariosWithBackup("scenario-content-restore-validation", [{
  id: "scenario-1",
  description: "",
  expectedResults: ""
}], [{
  id: "scenario-1",
  scenarioDescription: "The saved description is restored from the backup.",
  expectedResult: "The expected outcome is visible again."
}], new Set());

assert.equal(mergedScenarios[0].description, "The saved description is restored from the backup.");
assert.equal(mergedScenarios[0].expectedResults, "The expected outcome is visible again.");
console.log("Scenario descriptions and expected results are restored from non-empty backup fields.");

const folderScenarioMerge = mergeScenariosWithBackup("scenario-folder-membership-validation", [{
  id: "folder-1",
  scenarioId: "SCENARIO_FOLDER",
  isFolder: true,
  folderType: "scenario",
  title: "Requirements",
  memberScenarioIds: ["TS-REQ-01"]
}, {
  id: "scenario-record-1",
  scenarioId: "TS-REQ-01",
  title: "Verify requirements flow",
  description: "Scenario description remains available.",
  expectedResults: "The expected state is shown."
}], [], new Set());

const restoredFolder = folderScenarioMerge.find(scenario => scenario.id === "folder-1");
const restoredScenario = folderScenarioMerge.find(scenario => scenario.id === "scenario-record-1");
assert.deepEqual(restoredFolder.memberScenarioIds, ["scenario-record-1"]);
assert.equal(restoredScenario.folderId, "folder-1");
assert.equal(restoredScenario.description, "Scenario description remains available.");
assert.equal(restoredScenario.expectedResults, "The expected state is shown.");
console.log("Folder membership stored by scenario ID is restored and canonicalized to scenario record IDs.");

const mergedRecordedFlows = mergeRecordedFlowsWithBackup("recorded-flow-locator-validation", [{
  id: "flow-1",
  steps: [{
    id: "step-1",
    action: "click",
    locator: {
      primary: {
        type: "css",
        value: "[data-testid='continue']",
        playwright: "page.getByTestId('continue').click()"
      },
      alternatives: []
    }
  }]
}], new Set(), [{
  id: "flow-1",
  steps: [{
    id: "step-1",
    action: "click",
    locator: {
      primary: {
        type: "css",
        value: "element",
        playwright: "page.locator('element').click()"
      },
      alternatives: []
    }
  }]
}]);

assert.equal(mergedRecordedFlows[0].steps[0].locator.primary.value, "[data-testid='continue']");
assert.equal(mergedRecordedFlows[0].steps[0].locator.primary.playwright, "page.getByTestId('continue').click()");
console.log("Recorded-flow merges preserve exact locators over same-length generic backup steps.");

const restoredRecordedFlows = mergeRecordedFlowsWithBackup("recorded-flow-locator-restore-validation", [{
  id: "flow-2",
  steps: [{
    id: "step-2",
    action: "click",
    locator: { primary: { type: "css", value: "element" }, alternatives: [] }
  }]
}], new Set(), [{
  id: "flow-2",
  steps: [{
    id: "step-2",
    action: "click",
    locator: {
      primary: {
        type: "role",
        value: "Submit",
        playwright: "page.getByRole('button', { name: 'Submit' }).click()"
      },
      alternatives: []
    }
  }]
}]);

assert.equal(restoredRecordedFlows[0].steps[0].locator.primary.value, "Submit");
assert.equal(restoredRecordedFlows[0].steps[0].locator.primary.playwright, "page.getByRole('button', { name: 'Submit' }).click()");
console.log("Recorded-flow merges restore exact backup locators when the current copy is generic.");
