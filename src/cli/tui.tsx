import { Box, render, Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type {
  Approval,
  ApprovalRequest,
  CodingAgent,
} from "../coding/agent.js";
import type { AgentEvent } from "../core/hooks.js";
import type { Commands } from "./coding.js";
import { callSummary, failureText, help, resultSummary } from "./format.js";

type Entry = Readonly<{
  id: number;
  kind: "banner" | "user" | "text" | "tool" | "info" | "error";
  text: string;
  detail?: string;
  failed?: boolean;
}>;
type Pending = Readonly<{
  request: ApprovalRequest;
  resolve: (answer: Approval) => void;
}>;

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let nextId = 0;

function Diff({ preview }: { preview: string }) {
  return (
    <Box flexDirection="column">
      {preview
        .split("\n")
        .slice(0, 60)
        .map((line, index) => (
          <Text
            key={index}
            {...(line.startsWith("+") && !line.startsWith("+++")
              ? { color: "green" }
              : line.startsWith("-") && !line.startsWith("---")
                ? { color: "red" }
                : { dimColor: true })}
          >
            {line || " "}
          </Text>
        ))}
    </Box>
  );
}

function Item({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "banner":
      return (
        <Box borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text>
            <Text bold color="cyan">
              Yada
            </Text>
            <Text dimColor> {entry.text}</Text>
          </Text>
        </Box>
      );
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <Text bold>{entry.text}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={entry.failed ? "red" : "green"}>● </Text>
            {entry.text}
          </Text>
          <Text color={entry.failed ? "red" : "gray"}> ⎿ {entry.detail}</Text>
        </Box>
      );
    case "error":
      return <Text color="red">{entry.text}</Text>;
    case "info":
      return <Text dimColor>{entry.text}</Text>;
    default:
      return (
        <Box marginTop={1}>
          <Text>{entry.text}</Text>
        </Box>
      );
  }
}

function App(props: {
  agent: CodingAgent;
  commands: Commands;
  initial: string | undefined;
  subscribe: (listener: (event: AgentEvent) => void) => void;
}) {
  const { agent, commands } = props;
  const { exit } = useApp();
  const [entries, setEntries] = useState<Entry[]>([
    {
      id: nextId++,
      kind: "banner",
      text: `${agent.root} · /help for commands`,
    },
  ]);
  const [stream, setStream] = useState("");
  const [running, setRunning] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending>();
  const [tokens, setTokens] = useState({ input: 0, output: 0 });
  const [mode, setMode] = useState(agent.mode);
  const [tick, setTick] = useState(0);
  const controller = useRef<AbortController>(undefined);
  const streamed = useRef("");
  const started = useRef(0);

  const add = (entry: Omit<Entry, "id">) => {
    setEntries((list) => [...list, { ...entry, id: nextId++ }]);
  };
  const flush = () => {
    if (streamed.current.trim())
      add({ kind: "text", text: streamed.current.trim() });
    streamed.current = "";
    setStream("");
  };

  useEffect(() => {
    commands.approve = (request) =>
      new Promise((resolve) => {
        setPending({ request, resolve });
      });
    props.subscribe((event) => {
      if (event.type === "text_delta") {
        streamed.current += event.delta;
        setStream(streamed.current);
      } else if (event.type === "tool_started") {
        flush();
        setRunning((map) =>
          new Map(map).set(event.call.id, callSummary(event.call)),
        );
      } else if (event.type === "tool_finished") {
        setRunning((map) => {
          const next = new Map(map);
          next.delete(event.call.id);
          return next;
        });
        add({
          kind: "tool",
          text: callSummary(event.call),
          detail: resultSummary(event.content, event.failed),
          failed: event.failed || event.content.startsWith('{"error"'),
        });
      } else if (event.type === "model_finished" && event.usage) {
        const { inputTokens, outputTokens } = event.usage;
        setTokens((total) => ({
          input: total.input + inputTokens,
          output: total.output + outputTokens,
        }));
      }
    });
    if (props.initial) void submit(props.initial);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      setTick((value) => value + 1);
    }, 100);
    return () => {
      clearInterval(timer);
    };
  }, [busy]);

  async function submit(text: string) {
    const value = text.trim();
    if (!value) return;
    if (value.startsWith("/")) {
      const reply = await commands.run(value, help);
      if (reply === null) {
        exit();
        return;
      }
      setMode(agent.mode);
      add({ kind: "info", text: reply });
      return;
    }
    add({ kind: "user", text: value });
    controller.current = new AbortController();
    started.current = Date.now();
    setBusy(true);
    try {
      const result = await agent.send(value, controller.current.signal);
      if (result.status === "completed") {
        if (!streamed.current && result.text) streamed.current = result.text;
        flush();
      } else {
        flush();
        add({
          kind: "error",
          text: failureText("code" in result ? result.code : result.status),
        });
      }
    } catch (error) {
      flush();
      add({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      controller.current = undefined;
      setRunning(new Map());
      setBusy(false);
    }
  }

  const answer = (value: Approval) => {
    if (!pending) return;
    add({
      kind: "info",
      text: `${value === "no" ? "Declined" : "Allowed"} ${pending.request.tool}${value === "always" ? " for this session" : ""}`,
    });
    setPending(undefined);
    pending.resolve(value);
  };

  useInput((char, key) => {
    if (pending) {
      const choice = { y: "yes", n: "no", a: "always" }[char.toLowerCase()];
      if (choice) answer(choice as Approval);
      else if (key.escape || (key.ctrl && char === "c")) answer("no");
      if (key.ctrl && char === "c") controller.current?.abort();
      return;
    }
    if (key.ctrl && char === "c") {
      if (controller.current) controller.current.abort();
      else if (input) setInput("");
      else exit();
    } else if (key.escape) controller.current?.abort();
    else if (key.return) {
      if (busy) return;
      setInput("");
      void submit(input);
    } else if (key.backspace || key.delete)
      setInput((value) => value.slice(0, -1));
    else if (!key.ctrl && !key.meta && char)
      setInput((value) => value + char.replace(/\r?\n/g, " "));
  });

  const seconds = Math.floor((Date.now() - started.current) / 1000);
  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry) => <Item key={entry.id} entry={entry} />}
      </Static>
      {stream ? (
        <Box marginTop={1}>
          <Text>{stream}</Text>
        </Box>
      ) : null}
      {[...running].map(([id, summary]) => (
        <Text key={id}>
          <Text color="yellow">{frames[tick % frames.length]} </Text>
          {summary}
        </Text>
      ))}
      {pending ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginTop={1}
        >
          <Text bold>Allow {pending.request.tool}?</Text>
          <Diff preview={pending.request.preview} />
          <Text>
            <Text color="green">[y]es</Text> <Text color="red">[n]o</Text>{" "}
            <Text color="cyan">[a]lways this session</Text>
          </Text>
        </Box>
      ) : null}
      {busy && !pending && running.size === 0 ? (
        <Text color="yellow">
          {frames[tick % frames.length]} Thinking… {seconds}s · esc to stop
        </Text>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={busy ? "gray" : "cyan"}
        paddingX={1}
        marginTop={1}
      >
        <Text color="cyan">› </Text>
        <Text>{input}</Text>
        {busy ? null : <Text inverse> </Text>}
      </Box>
      <Text dimColor>
        {" "}
        {agent.provider.name} · mode {mode} · {tokens.input.toLocaleString()} in
        / {tokens.output.toLocaleString()} out
        {agent.session.title ? ` · ${agent.session.title.slice(0, 40)}` : ""}
      </Text>
    </Box>
  );
}

export async function runTui(
  agent: CodingAgent,
  commands: Commands,
  initial: string | undefined,
  subscribe: (listener: (event: AgentEvent) => void) => void,
) {
  const app = render(
    <App
      agent={agent}
      commands={commands}
      initial={initial}
      subscribe={subscribe}
    />,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
}
