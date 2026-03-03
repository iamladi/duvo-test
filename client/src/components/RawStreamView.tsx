import { useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { ArrowDown } from "lucide-react";
import type { RawEvent } from "shared";

const PAYLOAD_TRUNCATE = 10_000;

function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function RawEventItem({ event }: { event: RawEvent }) {
	const [expanded, setExpanded] = useState(false);

	const payloadStr = JSON.stringify(event.payload, null, 2);
	const isTruncated = payloadStr.length > PAYLOAD_TRUNCATE;
	const displayPayload =
		!expanded && isTruncated
			? `${payloadStr.slice(0, PAYLOAD_TRUNCATE)}\n\n[truncated]`
			: payloadStr;

	return (
		<div
			style={{
				borderBottom: "1px solid #1e293b",
				padding: "6px 12px",
				fontSize: "12px",
				fontFamily: "monospace",
			}}
		>
			<div
				style={{
					display: "flex",
					gap: "8px",
					alignItems: "center",
					cursor: "pointer",
					color: "#94a3b8",
				}}
				onClick={() => setExpanded(!expanded)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") setExpanded(!expanded);
				}}
				role="button"
				tabIndex={0}
			>
				<span style={{ color: "#64748b" }}>{formatTime(event.timestamp)}</span>
				<span
					style={{
						color: typeColor(event.type),
						fontWeight: 600,
					}}
				>
					{event.type}
				</span>
				<span style={{ color: "#475569", fontSize: "11px" }}>
					{expanded ? "▼" : "▶"}
				</span>
			</div>
			{expanded && (
				<div style={{ marginTop: "4px" }}>
					<pre
						style={{
							margin: 0,
							color: "#cbd5e1",
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							fontSize: "11px",
							maxHeight: "300px",
							overflowY: "auto",
						}}
					>
						{displayPayload}
					</pre>
					{isTruncated && !expanded && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								setExpanded(true);
							}}
							style={{
								background: "none",
								border: "none",
								color: "#3b82f6",
								cursor: "pointer",
								fontSize: "11px",
								padding: "2px 0",
							}}
						>
							Show full
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function typeColor(type: string): string {
	switch (type) {
		case "system":
			return "#a78bfa";
		case "stream_event":
			return "#22d3ee";
		case "assistant":
			return "#34d399";
		case "result":
			return "#fbbf24";
		case "user":
			return "#f97316";
		default:
			return "#94a3b8";
	}
}

export function RawStreamView({ events }: { events: RawEvent[] }) {
	const { scrollRef, contentRef, isAtBottom, scrollToBottom } =
		useStickToBottom();

	return (
		<div
			style={{
				height: "100%",
				display: "flex",
				flexDirection: "column",
				backgroundColor: "#0f172a",
				color: "#e2e8f0",
				position: "relative",
			}}
		>
			<div
				style={{
					padding: "8px 12px",
					fontSize: "11px",
					fontWeight: 600,
					color: "#64748b",
					textTransform: "uppercase",
					letterSpacing: "0.05em",
					borderBottom: "1px solid #1e293b",
					flexShrink: 0,
				}}
			>
				Raw SDK Events ({events.length})
			</div>
			<div
				ref={scrollRef}
				style={{
					flex: 1,
					overflowY: "auto",
				}}
			>
				<div ref={contentRef}>
					{events.length === 0 && (
						<div
							style={{
								padding: "24px",
								textAlign: "center",
								color: "#475569",
								fontSize: "13px",
							}}
						>
							Waiting for events...
						</div>
					)}
					{events.map((event) => (
						<RawEventItem key={event.id} event={event} />
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
						boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
					}}
				>
					<ArrowDown size={16} />
				</button>
			)}
		</div>
	);
}
