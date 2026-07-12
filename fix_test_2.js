const fs = require("node:fs");

let content = fs.readFileSync(
	"packages/connector-todoist/test/sync.test.ts",
	"utf-8",
);

content = content.replace(
	/vi\.module\("node:fs", \(\) => \(\{\n {2}mkdirSync: vi\.fn\(\),\n\};\n/g,
	'vi.module("node:fs", () => ({\n  mkdirSync: vi.fn(),\n}));\n',
);
content = content.replace(
	/const \{ mockApiSync, mockFetchCompletedTasks, mockPushLocalCommands \} = \{\n {2}mockApiSync: vi\.fn\(\),\n {2}mockFetchCompletedTasks: vi\.fn\(\),\n {2}mockPushLocalCommands: vi\.fn\(\),\n\};/g,
	"const { mockApiSync, mockFetchCompletedTasks, mockPushLocalCommands } = {\n  mockApiSync: vi.fn(),\n  mockFetchCompletedTasks: vi.fn(),\n  mockPushLocalCommands: vi.fn(),\n};",
);

fs.writeFileSync(
	"packages/connector-todoist/test/sync.test.ts",
	content,
	"utf-8",
);
