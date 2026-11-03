export const isTerminal = (status: string) =>
  status === "completed" || status === "failed" || status === "cancelled";
