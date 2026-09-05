# Markdown Backtick Parsing Fix

## Problem

The desktop and Android Markdown parsers treated the first line beginning with
three backticks as the end of a fenced code block. This breaks the standard
Markdown technique for displaying a fenced example inside another code block.

For example, Markdown uses a four-backtick outer fence when its literal content
contains three-backtick fences:

`````text
````markdown
```js
const x = 1;
```
````
`````

The three-backtick lines are content. Only the final four-backtick line closes
the outer block.

The inline parser had a related issue. It searched for the next individual
backtick, so it could not render inline code containing a longer run of
backticks.

## Standard Markdown rules used by the fix

### Fenced code blocks

- An opening fence is a run of at least three backticks.
- A closing fence is a bare run of backticks with no info string or other text.
- The closing run must be at least as long as the opening run.
- Content inside a fenced block is literal. Apparent opening fences inside it
  are not recursively parsed.
- To display an inner fenced example, make the outer fence longer than every
  fence in its content.

Arbitrary same-length nesting is not supported because a bare fence cannot
unambiguously mean both "open a nested block" and "close the current block."
An earlier stack-based attempt was removed for this reason.

### Inline code spans

- Consecutive backticks form one delimiter run.
- An opening run closes only on a run of exactly the same length.
- Runs of other lengths are literal code content.
- When the content starts and ends with a padding space and is not entirely
  spaces, one space is removed from each side.

For example, a one-backtick opener and closer can contain a literal
three-backtick run because the run lengths differ.

## Desktop implementation

The changes are in `js/render/markdown.js`.

### Block fence scan

The parser records the opening fence length and scans for a bare compatible
closing fence:

```js
const openingFence = trimmed.match(/^(`{3,})(.*)$/);
if (openingFence) {
  const fenceLength = openingFence[1].length;
  const code = [];
  let j = i + 1;

  while (j < lines.length) {
    const candidate = lines[j].trim().match(/^(`{3,})$/);
    if (candidate && candidate[1].length >= fenceLength) break;
    code.push(lines[j]);
    j++;
  }
}
```

A shorter fence or a fence followed by text remains part of the code content.
There is no nesting stack.

### Inline delimiter scan

When the inline parser sees a backtick, it counts the complete opening run. It
then scans subsequent backtick runs until it finds one with exactly the same
length. Differently sized runs are skipped as literal content.

## Suggested Android changes

`Markdown.java` has the same original block scan:

```java
while (j < lines.length && !lines[j].trim().startsWith("```")) {
    // append line
    j++;
}
```

Replace it with a length-aware scan. A small helper is sufficient:

```java
private static int leadingBackticks(String value) {
    int count = 0;
    while (count < value.length() && value.charAt(count) == '`') count++;
    return count >= 3 ? count : 0;
}
```

After recognizing the opening line, save its count. A candidate closes the
block only when all of the following are true:

1. Its trimmed text consists entirely of backticks.
2. It contains at least three backticks.
3. Its count is greater than or equal to the opening count.

Do not push apparent inner fences onto a stack. They are literal content.

Apply the same run-counting idea in `Markdown.inline`: count the opening run,
scan complete subsequent runs, and accept only a run with the exact same count.

## Regression tests

The desktop tests in `test/tests.js` cover:

- Existing simple three-backtick blocks.
- A fence with an info string inside code not acting as a closer.
- A four-backtick outer block containing a three-backtick fenced example.
- Inline code containing a three-backtick run inside one-backtick delimiters.
- Inline code containing a one-backtick run inside two-backtick delimiters.

Equivalent Android tests should verify both `Doc.text` and the `CODE_BLOCK` or
`CODE` span ranges. Existing fenced-block and inline-code tests should continue
to pass.
