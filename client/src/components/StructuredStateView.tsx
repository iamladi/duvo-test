import * as Accordion from "@radix-ui/react-accordion";
import { useStickToBottom } from "use-stick-to-bottom";
import { ArrowDown, Clock, Activity, Zap } from "lucide-react";
import type {
	AgentViewState,
	AssistantTurn,
	AutomationSummary,
	Turn,
} from "shared";
import { StepItem } from "./StepItem";

function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remainSecs = secs % 60;
	return `${mins}m ${remainSecs}s`;
}

function phaseLabel(phase: string | null): string {
	switch (phase) {
		case "thinking":
			return "Thinking";
		case "responding":
			return "Responding";
		case "tool_calling":
			return "Calling Tool";
		case "tool_executing":
			return "Executing Tool";
		case "complete":
			return "Complete";
		default:
			return "Idle";
	}
}

function automationPhaseLabel(phase: string): string {
	switch (phase) {
		case "idle":
			return "Ready";
		case "initiating":
			return "Starting...";
		case "streaming":
			return "Running";
		case "complete":
			return "Complete";
		case "error":
			return "Error";
		default:
			return phase;
	}
}

function phaseColor(phase: string): string {
	switch (phase) {
		case "idle":
			return "#6b7280";
		case "initiating":
			return "#f59e0b";
		case "streaming":
			return "#3b82f6";
		case "complete":
			return "#22c55e";
		case "error":
			return "#ef4444";
		default:
			return "#6b7280";
	}
}

function AutomationSummaryCard({ summary }: { summary: AutomationSummary }) {
	return (
		<div
			style={{
				padding: "12px 16px",
				borderBottom: "1px solid #e5e7eb",
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				flexShrink: 0,
			}}
		>
			<div
				style={{ display: "flex", alignItems: "center", gap: "8px" }}
			>
				<Activity size={14} style={{ color: phaseColor(summary.phase) }} />
				<span
					style={{
						fontSize: "13px",
						fontWeight: 600,
						color: phaseColor(summary.phase),
					}}
				>
					{automationPhaseLabel(summary.phase)}
				</span>
				{summary.turnPhase && summary.phase === "streaming" && (
					<span
						style={{
							fontSize: "12px",
							color: "#6b7280",
							marginLeft: "4px",
						}}
					>
						— {phaseLabel(summary.turnPhase)}
					</span>
				)}
			</div>
			<div
				style={{
					display: "flex",
					gap: "16px",
					fontSize: "12px",
					color: "#6b7280",
				}}
			>
				<span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
					<Zap size={12} />
					{summary.completedStepCount} steps
				</span>
				{summary.elapsedMs > 0 && (
					<span
						style={{ display: "flex", alignItems: "center", gap: "4px" }}
					>
						<Clock size={12} />
						{formatElapsed(summary.elapsedMs)}
					</span>
				)}
			</div>
		</div>
	);
}

function TurnSection({
	turn,
	isLatest,
}: { turn: Turn; isLatest: boolean }) {
	if (turn.role === "user") {
		return (
			<div
				style={{
					padding: "8px 16px",
					fontSize: "13px",
					color: "#374151",
					backgroundColor: "#f0f7ff",
					borderBottom: "1px solid #e5e7eb",
				}}
			>
				<span style={{ fontWeight: 600, color: "#1d4ed8" }}>You: </span>
				{turn.content}
			</div>
		);
	}

	const assistantTurn = turn as AssistantTurn;
	const activeStepIds = assistantTurn.steps
		.filter((s) => s.status === "running")
		.map((s) => s.id);

	const defaultValue = isLatest
		? assistantTurn.steps.map((s) => s.id)
		: [];

	return (
		<div style={{ borderBottom: "1px solid #e5e7eb" }}>
			{!isLatest && (
				<div
					style={{
						padding: "6px 16px",
						fontSize: "11px",
						color: "#9ca3af",
						backgroundColor: "#f9fafb",
					}}
				>
					Previous turn ({assistantTurn.steps.length} steps)
				</div>
			)}
			<Accordion.Root
				type="multiple"
				defaultValue={defaultValue}
				value={isLatest ? [...defaultValue, ...activeStepIds] : undefined}
			>
				{assistantTurn.steps.map((step) => (
					<StepItem key={step.id} step={step} />
				))}
			</Accordion.Root>
		</div>
	);
}

export function StructuredStateView({
	state,
	summary,
}: {
	state: AgentViewState;
	summary: AutomationSummary;
}) {
	const { scrollRef, contentRef, isAtBottom, scrollToBottom } =
		useStickToBottom();

	const turns = state.conversation.turns;

	return (
		<div
			style={{
				height: "100%",
				display: "flex",
				flexDirection: "column",
				backgroundColor: "#ffffff",
				position: "relative",
			}}
		>
			<AutomationSummaryCard summary={summary} />
			<div
				ref={scrollRef}
				style={{
					flex: 1,
					overflowY: "auto",
				}}
			>
				<div ref={contentRef}>
					{turns.length === 0 && (
						<div
							style={{
								padding: "24px",
								textAlign: "center",
								color: "#9ca3af",
								fontSize: "13px",
							}}
						>
							Send a message to start.
						</div>
					)}
					{turns.map((turn, i) => (
						<TurnSection
							key={turn.id}
							turn={turn}
							isLatest={i === turns.length - 1 || i === turns.length - 2}
						/>
					))}
				</div>
			</div>
			{!isAtBottom && (
				<button
					type="button"
					onClick={() => scrollToBottom()}
					style={{
						position: "absolute",
						bottom: "16px",
						right: "16px",
						width: "32px",
						height: "32px",
						borderRadius: "50%",
						backgroundColor: "#3b82f6",
						color: "#fff",
						border: "none",
						cursor: "pointer",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
					}}
				>
					<ArrowDown size={16} />
				</button>
			)}
		</div>
	);
}
