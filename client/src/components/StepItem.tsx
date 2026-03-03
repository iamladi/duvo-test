import { useEffect, useRef } from "react";
import * as Accordion from "@radix-ui/react-accordion";
import {
	Loader2,
	CheckCircle2,
	XCircle,
	Circle,
	ChevronDown,
} from "lucide-react";
import type { Step } from "shared";

const TRUNCATE_LIMIT = 50_000;

function StatusIcon({ status }: { status: Step["status"] }) {
	switch (status) {
		case "running":
			return (
				<Loader2
					size={16}
					style={{ animation: "spin 1s linear infinite", color: "#3b82f6" }}
				/>
			);
		case "complete":
			return <CheckCircle2 size={16} style={{ color: "#22c55e" }} />;
		case "error":
			return <XCircle size={16} style={{ color: "#ef4444" }} />;
		case "pending":
		default:
			return <Circle size={16} style={{ color: "#9ca3af" }} />;
	}
}

function stepLabel(step: Step): string {
	switch (step.type) {
		case "thinking":
			return "Thinking";
		case "text":
			return "Text";
		case "tool_use":
			return step.toolName;
		case "tool_result":
			return `Result: ${step.toolName}`;
	}
}

function stepContent(step: Step): string {
	switch (step.type) {
		case "thinking":
			return step.content;
		case "text":
			return step.content;
		case "tool_use":
			if (step.parsedInput) {
				return JSON.stringify(step.parsedInput, null, 2);
			}
			return step.inputJson;
		case "tool_result":
			return step.content;
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function DynamicAccordionContent({
	children,
}: { children: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			const wrapper = el.closest("[data-radix-accordion-content]");
			if (wrapper instanceof HTMLElement) {
				wrapper.style.setProperty(
					"--radix-accordion-content-height",
					`${el.scrollHeight}px`,
				);
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return <div ref={ref}>{children}</div>;
}

export function StepItem({ step }: { step: Step }) {
	const content = stepContent(step);
	const isTruncated = content.length > TRUNCATE_LIMIT;
	const displayContent = isTruncated
		? `${content.slice(0, TRUNCATE_LIMIT)}\n\n[truncated — ${content.length.toLocaleString()} chars total]`
		: content;
	const duration =
		step.endTime ? formatDuration(step.endTime - step.startTime) : "";

	return (
		<Accordion.Item
			value={step.id}
			style={{
				borderBottom: "1px solid #e5e7eb",
			}}
		>
			<Accordion.Header style={{ margin: 0 }}>
				<Accordion.Trigger
					style={{
						display: "flex",
						alignItems: "center",
						gap: "8px",
						width: "100%",
						padding: "8px 12px",
						background: "none",
						border: "none",
						cursor: "pointer",
						fontSize: "13px",
						fontFamily: "monospace",
						color: "#374151",
						textAlign: "left",
					}}
				>
					<StatusIcon status={step.status} />
					<span style={{ fontWeight: 500 }}>{stepLabel(step)}</span>
					{duration && (
						<span style={{ color: "#9ca3af", marginLeft: "auto" }}>
							{duration}
						</span>
					)}
					<ChevronDown
						size={14}
						style={{
							color: "#9ca3af",
							transition: "transform 200ms",
							flexShrink: 0,
						}}
					/>
				</Accordion.Trigger>
			</Accordion.Header>
			<Accordion.Content
				forceMount={step.status === "running" ? true : undefined}
				style={{
					overflow: "hidden",
					transition: "height 200ms ease-out",
				}}
			>
				<DynamicAccordionContent>
					<pre
						style={{
							margin: 0,
							padding: "8px 12px 12px 36px",
							fontSize: "12px",
							fontFamily: "monospace",
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							color: "#4b5563",
							maxHeight: "400px",
							overflowY: "auto",
						}}
					>
						{displayContent || (step.status === "running" ? "..." : "(empty)")}
					</pre>
				</DynamicAccordionContent>
			</Accordion.Content>
		</Accordion.Item>
	);
}
