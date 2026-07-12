const fs = require("node:fs");

let content = fs.readFileSync(
	"packages/connector-todoist/test/sync.test.ts",
	"utf-8",
);

// Using bun testing requires mock definitions to be rewritten as simple mocks

content = content.replace(
	/const mockConfig = \(\(\) => \(\{/g,
	"const mockConfig = {",
);
content = content.replace(/\}\)\);/g, "};");

content = content.replace(
	/vi\.mock\('\.\.\/src\/config\.js', \(\) => mockConfig\);/g,
	'vi.module("../src/config.js", () => mockConfig);',
);
content = content.replace(
	/vi\.mock\('node:fs', \(\) => \(\{/g,
	'vi.module("node:fs", () => ({',
);

content = content.replace(
	/const \{ mockApiSync, mockFetchCompletedTasks, mockPushLocalCommands \} = vi\.hoisted\(\(\) => \(\{/g,
	"const { mockApiSync, mockFetchCompletedTasks, mockPushLocalCommands } = {",
);
content = content.replace(
	/vi\.mock\('\.\.\/src\/api\.js', \(\) => \(\{/g,
	'vi.module("../src/api.js", () => ({',
);
content = content.replace(
	/const \{ mockLoadState, mockSaveState, mockReadTasksFile, mockSaveTasksFile \} = vi\.hoisted\(\(\) => \(\{/g,
	"const { mockLoadState, mockSaveState, mockReadTasksFile, mockSaveTasksFile } = {",
);
content = content.replace(
	/vi\.mock\('\.\.\/src\/state\.js', \(\) => \(\{/g,
	'vi.module("../src/state.js", () => ({',
);
content = content.replace(
	/const \{ mockParseTasks, mockApplyRemoteChanges, mockFormatTaskWithAttributes, mockStringifyTasks \} = vi\.hoisted\(\(\) => \(\{/g,
	"const { mockParseTasks, mockApplyRemoteChanges, mockFormatTaskWithAttributes, mockStringifyTasks } = {",
);
content = content.replace(
	/vi\.mock\('\.\.\/src\/markdown\.js', \(\) => \(\{/g,
	'vi.module("../src/markdown.js", () => ({',
);

fs.writeFileSync(
	"packages/connector-todoist/test/sync.test.ts",
	content,
	"utf-8",
);
