const fs = require("node:fs");

let content = fs.readFileSync(
	"packages/connector-todoist/test/sync.test.ts",
	"utf-8",
);

content = content.replace(
	/vi\.module\("\.\.\/src\/api\.js", \(\) => \(\{\n {2}api: \{ sync: \(\.\.\.args: any\[\]\) => mockApiSync\(\.\.\.args\) \},\n {2}fetchCompletedTasks: \(\.\.\.args: any\[\]\) => mockFetchCompletedTasks\(\.\.\.args\),\n {2}pushLocalCommands: \(\.\.\.args: any\[\]\) => mockPushLocalCommands\(\.\.\.args\),\n\};\n/g,
	'vi.module("../src/api.js", () => ({\n  api: { sync: (...args: any[]) => mockApiSync(...args) },\n  fetchCompletedTasks: (...args: any[]) => mockFetchCompletedTasks(...args),\n  pushLocalCommands: (...args: any[]) => mockPushLocalCommands(...args),\n}));\n',
);

content = content.replace(
	/vi\.module\("\.\.\/src\/state\.js", \(\) => \(\{\n {2}loadState: \(\.\.\.args: any\[\]\) => mockLoadState\(\.\.\.args\),\n {2}saveState: \(\.\.\.args: any\[\]\) => mockSaveState\(\.\.\.args\),\n {2}readTasksFile: \(\.\.\.args: any\[\]\) => mockReadTasksFile\(\.\.\.args\),\n {2}saveTasksFile: \(\.\.\.args: any\[\]\) => mockSaveTasksFile\(\.\.\.args\),\n\};\n/g,
	'vi.module("../src/state.js", () => ({\n  loadState: (...args: any[]) => mockLoadState(...args),\n  saveState: (...args: any[]) => mockSaveState(...args),\n  readTasksFile: (...args: any[]) => mockReadTasksFile(...args),\n  saveTasksFile: (...args: any[]) => mockSaveTasksFile(...args),\n}));\n',
);

content = content.replace(
	/vi\.module\("\.\.\/src\/markdown\.js", \(\) => \(\{\n {2}parseTasks: \(\.\.\.args: any\[\]\) => mockParseTasks\(\.\.\.args\),\n {2}applyRemoteChanges: \(\.\.\.args: any\[\]\) => mockApplyRemoteChanges\(\.\.\.args\),\n {2}formatTaskWithAttributes: \(\.\.\.args: any\[\]\) => mockFormatTaskWithAttributes\(\.\.\.args\),\n {2}stringifyTasks: \(\.\.\.args: any\[\]\) => mockStringifyTasks\(\.\.\.args\),\n\};\n/g,
	'vi.module("../src/markdown.js", () => ({\n  parseTasks: (...args: any[]) => mockParseTasks(...args),\n  applyRemoteChanges: (...args: any[]) => mockApplyRemoteChanges(...args),\n  formatTaskWithAttributes: (...args: any[]) => mockFormatTaskWithAttributes(...args),\n  stringifyTasks: (...args: any[]) => mockStringifyTasks(...args),\n}));\n',
);

fs.writeFileSync(
	"packages/connector-todoist/test/sync.test.ts",
	content,
	"utf-8",
);
