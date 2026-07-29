import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseConsoleCandidate,
  selectConsoleText,
} from "../src/xcodeConsoleReaderInternals.js";

test("chooses a Console text area from an entireContents snapshot when windows are empty", () => {
  const candidate = chooseConsoleCandidate([
    { role: "AXButton", description: "Run", name: "Run", value: "" },
    {
      role: "AXTextArea",
      description: "控制台",
      name: "Debug Console",
      value: "[Log][Info] ready",
    },
  ]);

  assert.equal(candidate.name, "Debug Console");
});

test("does not select an unrelated text area over a named Console candidate", () => {
  const candidate = chooseConsoleCandidate([
    {
      role: "AXTextArea",
      description: "Editor",
      name: "Source Editor",
      value: "lots of source text",
    },
    {
      role: "AXTextArea",
      description: "Console",
      name: "Console",
      value: "new log line",
    },
  ]);

  assert.equal(candidate.name, "Console");
});

test("resets the cursor when Xcode truncates or clears the Console", () => {
  assert.deepEqual(
    selectConsoleText("new line\n", 100, { query: "", tailLines: 100, maxResults: 100, maxCharsPerLine: 2000 }),
    {
      totalCharacters: 9,
      selectedCharacters: 9,
      afterCharacter: 0,
      nextCharacter: 9,
      truncated: true,
      lines: ["new line"],
    },
  );
});
