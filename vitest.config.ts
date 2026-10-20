import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		testTimeout: 30000, // Increase timeout for subprocess tests
		include: ["test/**/*.test.ts"],
		// zshy.test.ts rebuilds the fixtures in place and ts7-fidelity.test.ts reads them, so they must not overlap
		fileParallelism: false,
		snapshotFormat: {
			escapeString: false,
			printBasicPrototype: false,
		},
	},
});
