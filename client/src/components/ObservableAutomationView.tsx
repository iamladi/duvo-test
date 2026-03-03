import { useState } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { useAgentView } from "../hooks/useAgentView";
import { RawStreamView } from "./RawStreamView";
import { StructuredStateView } from "./StructuredStateView";

function formatCost(usd: number): string {
	if (usd < 0.01) return `$${usd.toFixed(6)}`;
	return `$${usd.toFixed(4)}`;
}

const DEFAULT_MCP_PATH = "demo-data";

export function ObservableAutomationView() {
	const { state, summary, sendMessage, abort } = useAgentView();
	const [input, setInput] = useState("");
	const lastPromptRef = useState<string | null>(null);
	const [mcpEnabled, setMcpEnabled] = useState(false);
	const [mcpPath, setMcpPath] = useState(DEFAULT_MCP_PATH);

	const isStreaming =
		state.automation === "streaming" || state.automation === "initiating";
	const hasSession = state.conversation.sessionId !== null;

	function getMcpConnection() {
		return mcpEnabled ? { enabled: true, path: mcpPath } : undefined;
	}

	function handleSend() {
		const prompt = input.trim();
		if (!prompt || isStreaming) return;
		lastPromptRef[1](prompt);
		setInput("");
		sendMessage(prompt, false, getMcpConnection());
	}

	function handleRetry() {
		const lastPrompt = lastPromptRef[0];
		if (lastPrompt) {
			sendMessage(lastPrompt, true, getMcpConnection());
		}
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100vh",
				fontFamily:
					'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
			}}
		>
			{/* Split pane area */}
			<div style={{ flex: 1, minHeight: 0 }}>
				<Group orientation="horizontal">
					<Panel defaultSize={40} minSize={20}>
						<div style={{ height: "100%", overflow: "hidden" }}>
							<RawStreamView events={state.rawEvents} />
						</div>
					</Panel>
					<Separator
						style={{
							width: "4px",
							backgroundColor: "#e5e7eb",
							cursor: "col-resize",
							transition: "background-color 150ms",
						}}
					/>
					<Panel defaultSize={60} minSize={20}>
						<div style={{ height: "100%", overflow: "hidden" }}>
							<StructuredStateView state={state} summary={summary} />
						</div>
					</Panel>
				</Group>
			</div>

			{/* Result footer */}
			{state.lastResult && state.automation !== "streaming" && (
				<div
					style={{
						padding: "6px 16px",
						fontSize: "12px",
						color: "#6b7280",
						borderTop: "1px solid #e5e7eb",
						display: "flex",
						gap: "16px",
						backgroundColor: "#f9fafb",
						flexShrink: 0,
					}}
				>
					<span>Cost: {formatCost(state.lastResult.totalCostUsd)}</span>
					<span>In: {state.lastResult.usage.inputTokens.toLocaleString()} tokens</span>
					<span>Out: {state.lastResult.usage.outputTokens.toLocaleString()} tokens</span>
					<span>Time: {(state.lastResult.durationMs / 1000).toFixed(1)}s</span>
					<span>Turns: {state.lastResult.numTurns}</span>
				</div>
			)}

			{/* Created files */}
			{state.createdFiles.length > 0 && (
				<div
					style={{
						padding: "8px 16px",
						borderTop: "1px solid #e5e7eb",
						display: "flex",
						flexDirection: "column",
						gap: "6px",
						backgroundColor: "#f0f7ff",
						flexShrink: 0,
					}}
				>
					{state.createdFiles.map((file) => (
						<div
							key={file.downloadUrl}
							style={{
								display: "flex",
								alignItems: "center",
								gap: "10px",
								fontSize: "13px",
							}}
						>
							<span style={{ color: "#374151" }}>{file.filename}</span>
							<a
								href={file.downloadUrl}
								download={file.filename}
								style={{
									padding: "3px 10px",
									backgroundColor: "#3b82f6",
									color: "#fff",
									borderRadius: "4px",
									textDecoration: "none",
									fontSize: "12px",
								}}
							>
								Download
							</a>
						</div>
					))}
				</div>
			)}

			{/* Error display */}
			{state.error && (
				<div
					style={{
						padding: "10px 16px",
						backgroundColor: "#fef2f2",
						borderTop: "1px solid #fecaca",
						color: "#dc2626",
						display: "flex",
						alignItems: "center",
						gap: "12px",
						fontSize: "13px",
						flexShrink: 0,
					}}
				>
					<span style={{ flex: 1 }}>
						Error: {state.error.message}
						{state.error.code && (
							<span style={{ color: "#9ca3af", marginLeft: "8px" }}>
								({state.error.code})
							</span>
						)}
					</span>
					<button
						type="button"
						onClick={handleRetry}
						style={{
							padding: "4px 12px",
							cursor: "pointer",
							border: "1px solid #dc2626",
							borderRadius: "6px",
							backgroundColor: "transparent",
							color: "#dc2626",
							fontSize: "13px",
						}}
					>
						Retry
					</button>
				</div>
			)}

			{/* MCP Connection card */}
			<div
				style={{
					padding: "8px 16px",
					borderTop: "1px solid #e5e7eb",
					display: "flex",
					gap: "10px",
					alignItems: "center",
					backgroundColor: mcpEnabled ? "#f0fdf4" : "#f9fafb",
					flexShrink: 0,
					fontSize: "13px",
				}}
			>
				<span
					style={{
						width: "8px",
						height: "8px",
						borderRadius: "50%",
						backgroundColor: mcpEnabled ? "#22c55e" : "#d1d5db",
						flexShrink: 0,
					}}
				/>
				<span style={{ color: "#374151", fontWeight: 500, whiteSpace: "nowrap" }}>
					Filesystem {mcpEnabled ? "Connected" : "Disconnected"}
				</span>
				<input
					type="text"
					value={mcpPath}
					onChange={(e) => setMcpPath(e.target.value)}
					disabled={hasSession}
					placeholder="Path to directory"
					style={{
						flex: 1,
						padding: "4px 8px",
						borderRadius: "4px",
						border: "1px solid #d1d5db",
						fontSize: "13px",
						fontFamily: "monospace",
						backgroundColor: hasSession ? "#f3f4f6" : "#fff",
					}}
				/>
				<button
					type="button"
					onClick={() => setMcpEnabled(!mcpEnabled)}
					disabled={hasSession}
					style={{
						padding: "4px 12px",
						borderRadius: "4px",
						border: `1px solid ${mcpEnabled ? "#dc2626" : "#22c55e"}`,
						backgroundColor: "transparent",
						color: mcpEnabled ? "#dc2626" : "#16a34a",
						cursor: hasSession ? "not-allowed" : "pointer",
						fontSize: "13px",
						whiteSpace: "nowrap",
						opacity: hasSession ? 0.5 : 1,
					}}
				>
					{mcpEnabled ? "Disconnect" : "Connect"}
				</button>
			</div>

			{/* Input area */}
			<div
				style={{
					padding: "12px 16px",
					borderTop: "1px solid #d1d5db",
					display: "flex",
					gap: "8px",
					alignItems: "center",
					backgroundColor: "#fff",
					flexShrink: 0,
				}}
			>
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Type a message..."
					disabled={isStreaming}
					style={{
						flex: 1,
						padding: "10px 14px",
						borderRadius: "8px",
						border: "1px solid #d1d5db",
						fontSize: "14px",
						outline: "none",
						backgroundColor: isStreaming ? "#f9fafb" : "#fff",
					}}
				/>

				{isStreaming ? (
					<button
						type="button"
						onClick={abort}
						style={{
							padding: "10px 18px",
							borderRadius: "8px",
							border: "1px solid #dc2626",
							backgroundColor: "#fef2f2",
							color: "#dc2626",
							cursor: "pointer",
							fontSize: "14px",
							whiteSpace: "nowrap",
						}}
					>
						Stop
					</button>
				) : (
					<button
						type="button"
						onClick={handleSend}
						disabled={!input.trim()}
						style={{
							padding: "10px 18px",
							borderRadius: "8px",
							border: "none",
							backgroundColor: input.trim() ? "#3b82f6" : "#d1d5db",
							color: "#fff",
							cursor: input.trim() ? "pointer" : "not-allowed",
							fontSize: "14px",
							whiteSpace: "nowrap",
						}}
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
