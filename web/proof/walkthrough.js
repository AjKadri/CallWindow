const container = document.getElementById("proof-walkthrough");

const mainFlow = [
  ["Funded buy order", "Place funded matched buy order"],
  ["Funded sell order", "Place funded matched sell order"],
  ["Finalized matched close", "Close matched auction at cutoff"],
  ["Buyer claim", "Buyer claims matched shares and quote refund"],
  ["Seller claim", "Seller claims matched USDC test proceeds"],
];

const refundFlow = [
  ["Funded buy order", "Place no-cross buy order"],
  ["Funded sell order", "Place no-cross sell order"],
  ["Finalized no-cross close", "Close no-cross auction at cutoff"],
  ["Buyer refund", "Buyer claims full no-cross quote refund"],
  ["Seller refund", "Seller claims full no-cross base refund"],
];

function stepElement(step, index, transactions) {
  const [title, label] = step;
  const item = transactions.get(label);
  const article = document.createElement("article");
  article.className = "walkthrough-step";
  const number = document.createElement("span");
  number.className = "walkthrough-number";
  number.textContent = String(index + 1).padStart(2, "0");
  const body = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = title;
  const link = document.createElement("a");
  link.href = item.explorerUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = `${item.label} ↗`;
  body.append(heading, link);
  article.append(number, body);
  return article;
}

function flowCard(title, description, steps, transactions, branch = false) {
  const article = document.createElement("article");
  article.className = `walkthrough-card${branch ? " walkthrough-branch" : ""}`;
  const kicker = document.createElement("p");
  kicker.className = "section-kicker";
  kicker.textContent = branch ? "Separate refund branch" : "Matched flow";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description;
  const list = document.createElement("div");
  list.className = "walkthrough-steps";
  steps.forEach((step, index) => list.append(stepElement(step, index, transactions)));
  article.append(kicker, heading, copy, list);
  return article;
}

async function renderWalkthrough() {
  try {
    const response = await fetch("/devnet-proof.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Proof file request failed");
    const proof = await response.json();
    const transactions = new Map((proof.transactions ?? []).map((item) => [item.label, item]));
    const required = [...mainFlow, ...refundFlow].map(([, label]) => label);
    if (required.some((label) => !transactions.get(label)?.explorerUrl)) throw new Error("Proof link is incomplete");

    const intro = document.createElement("p");
    intro.className = "walkthrough-note";
    intro.textContent = "Static replay of finalized devnet transactions. No simulated live progress.";
    const grid = document.createElement("div");
    grid.className = "walkthrough-grid";
    grid.append(
      flowCard("Funded orders settle at one price", "Funded buy and sell orders reach a finalized matched close, then each side claims its result.", mainFlow, transactions),
      flowCard("No cross means refunds", "When funded interest does not cross, the finalized close returns the quote and base deposits.", refundFlow, transactions, true),
    );
    container.replaceChildren(intro, grid);
  } catch {
    container.innerHTML = "<p class=\"empty-state\">The tracked public proof walkthrough is unavailable in this build.</p>";
  }
}

renderWalkthrough();
