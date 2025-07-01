import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		testTimeout: 30000, // Increase timeout for subprocess tests
		snapshotFormat: {
			escapeString: false,
			printBasicPrototype: false,
		},
	},
});
