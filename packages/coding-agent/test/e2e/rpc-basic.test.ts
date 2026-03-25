/**
 * RPC E2E: Basic connectivity + info-only commands.
 * Flowchart sections: 1 (launch), 8 (management commands), 12 (RPC mode).
 *
 * These tests verify the RPC protocol works and info-only commands
 * (list, status, delete) return via notification without starting agent turns.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	attachAutoApprove,
	createRpcTestEnv,
	MINIMAX_API_KEY,
	type RpcTestEnv,
	seedWorkflow,
	sendAndCollectNotifications,
} from "./rpc-test-helpers";

describe.skipIf(!MINIMAX_API_KEY)("RPC basic + info commands", () => {
	let env: RpcTestEnv;

	beforeEach(() => {
		env = createRpcTestEnv();
	});
	afterEach(() => env.cleanup());

	test("simple prompt works via RPC", async () => {
		await env.client.start();
		await env.client.promptAndWait("Say exactly: HELLO_TEST_MARKER", undefined, 60_000);
		const text = await env.client.getLastAssistantText();
		expect(text).toContain("HELLO_TEST_MARKER");
	}, 90_000);

	test("workflow list returns info via notification", async () => {
		await env.client.start();
		const slug = "test-list-slug";
		seedWorkflow(env.workDir, slug, []);
		const notifications = await sendAndCollectNotifications(env.client, "/workflow list");
		const listSelect = notifications.find(n => n.method === "select");
		expect(listSelect).toBeDefined();
		expect((listSelect as { options: string[] }).options.some(o => o.includes(slug))).toBe(true);
	}, 30_000);

	test("workflow status shows state via notification", async () => {
		await env.client.start();
		const slug = "test-status-slug";
		seedWorkflow(env.workDir, slug, ["brainstorm"]);
		const notifications = await sendAndCollectNotifications(env.client, `/workflow status ${slug}`);
		const statusNotify = notifications.find(n => n.method === "notify");
		expect(statusNotify).toBeDefined();
		expect((statusNotify as { message: string }).message).toContain(slug);
	}, 30_000);

	test("workflow delete removes files", async () => {
		await env.client.start();
		attachAutoApprove(env.client);
		const slug = "test-delete-slug";
		seedWorkflow(env.workDir, slug, []);
		const notifications = await sendAndCollectNotifications(env.client, `/workflow delete ${slug}`);
		const deleteNotify = notifications.find(n => n.method === "notify");
		expect(deleteNotify).toBeDefined();
		expect((deleteNotify as { message: string }).message).toContain(slug);
		expect(fs.existsSync(path.join(env.workDir, "docs", "workflow", slug))).toBe(false);
	}, 30_000);

	test("spec rejects when brainstorm is missing", async () => {
		await env.client.start();
		const notifications = await sendAndCollectNotifications(env.client, "/workflow spec nonexistent-slug");
		const errorNotify = notifications.find(n => n.method === "notify");
		expect(errorNotify).toBeDefined();
		expect((errorNotify as { message: string }).message.length).toBeGreaterThan(0);
	}, 30_000);
});
