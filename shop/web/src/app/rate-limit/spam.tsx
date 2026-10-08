"use client";

import { useActionState } from "react";
import { spam, type SpamState } from "../actions";

export function SpamButton() {
  const [state, action, pending] = useActionState<SpamState>(spam, null);
  return (
    <form action={action} className="card">
      <button type="submit" disabled={pending}>Click me</button>{" "}
      {state && (state.allowed ? (
        <span>Allowed: {state.count} of {state.limit} this minute.</span>
      ) : (
        <span className="error">429 — over the limit ({state.count}/{state.limit}). Resets in {state.resetIn}s.</span>
      ))}
    </form>
  );
}
