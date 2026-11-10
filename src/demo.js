/**
 * Demo mode: a small pattern matcher standing in for Claude when no API key is
 * set. It has the same shape as the SDK client, so everything around it (agent
 * loop, tools, ledger, UI) runs for real. It understands a few fixed Roman-script
 * phrases and is not a preview of how the real assistant behaves.
 */
import { romanize } from "../public/romanize.js";

const HELP = "Demo mode mein main kuch hi baatein samajhta hoon. Try: 'Ramesh ko 500 udhaar diya', 'Ramesh ne 200 diye', '300 ka kharcha', '1000 ki sale', 'aaj ka hisaab', 'kitna udhaar baaki hai', 'stock dikhao', or 'undo'.";

function parse(raw) {
  const text = romanize(raw).toLowerCase().replace(/(?<=\d),(?=\d)/g, "");
  const num = (m) => Number(m);
  const call = (name, input) => ({ name, input });
  let m;

  if ((m = text.match(/([a-z]+) ko (?:rs\.? ?|₹ ?)?(\d+(?:\.\d+)?).*(?:udh|credit)/))) {
    return call("record_sale", { amount: num(m[2]), paid_amount: 0, customer_name: titleCase(m[1]) });
  }
  if ((m = text.match(/([a-z]+) ne (?:rs\.? ?|₹ ?)?(\d+(?:\.\d+)?).*(?:diye|paid|jama)/))) {
    return call("record_payment", { amount: num(m[2]), customer_name: titleCase(m[1]) });
  }
  if (/\b(undo|galat|wapas)\b/.test(text)) return call("undo_last_action", {});
  if ((m = text.match(/(\d+(?:\.\d+)?).*(?:kharch|expense|spent)/))) {
    return call("record_expense", { amount: num(m[1]), category: "other" });
  }
  if ((m = text.match(/(\d+(?:\.\d+)?).*(?:\bsale\b|bikri|becha|sold)/))) {
    return call("record_sale", { amount: num(m[1]), paid_amount: num(m[1]) });
  }
  if (/\b(stock|maal|inventory)\b/.test(text)) return call("list_stock", {});
  if (/udh|baa?ki|pending/.test(text)) return call("list_pending_payments", {});
  if (/hisaab|hisab|summary|today/.test(text)) return call("get_business_summary", {});
  return null;
}

const titleCase = (word) => word[0].toUpperCase() + word.slice(1);
const inr = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

function replyFor(toolName, content, isError) {
  if (isError) return `Yeh nahi ho paya: ${content}`;
  const r = JSON.parse(content);
  switch (toolName) {
    case "record_sale":
    case "record_expense":
    case "record_payment":
      return `Ho gaya. ${r.recorded}.${r.remaining_balance != null ? ` Baaki ${inr(r.remaining_balance)}.` : ""}`;
    case "undo_last_action":
      return `Theek hai, hata diya: ${r.undone}.`;
    case "list_pending_payments":
      if (!r.customers.length) return "Kisi ka udhaar baaki nahi hai.";
      return `Kul ${inr(r.total_outstanding)} baaki hai. Sabse zyada ${r.customers[0].name} ka, ${inr(r.customers[0].owes)}.`;
    case "list_stock": {
      if (!r.items.length) return "Abhi koi stock item save nahi hai.";
      const low = r.items.filter((i) => i.low);
      return `${r.items.length} items stock mein hain.${low.length ? ` Kam hai: ${low.map((i) => `${i.name} (${i.on_hand} ${i.unit})`).join(", ")}.` : " Sab theek hai."}`;
    }
    case "get_business_summary":
      return `Aaj ki sale ${inr(r.sales)}, kharcha ${inr(r.expenses)}. Kul udhaar baaki ${inr(r.total_outstanding_now)}.`;
    default:
      return "Ho gaya.";
  }
}

export function createDemoClient() {
  let nextId = 1;
  return {
    provider: "demo",
    beta: {
      messages: {
        stream({ messages }) {
          const message = respond(messages);
          let onText = () => {};
          return {
            on(event, handler) {
              if (event === "text") onText = handler;
              return this;
            },
            async finalMessage() {
              for (const block of message.content) if (block.type === "text") onText(block.text);
              return message;
            },
          };
        },
      },
    },
  };

  function respond(messages) {
    const last = messages.at(-1).content;
    if (last[0]?.type === "tool_result") {
      const previous = messages.at(-2).content.find((b) => b.type === "tool_use");
      return say(replyFor(previous.name, last[0].content, last[0].is_error));
    }
    const action = parse(last.at(-1).text);
    if (!action) return say(HELP);
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `demo_${nextId++}`, ...action }] };
  }

  function say(text) {
    return { stop_reason: "end_turn", content: [{ type: "text", text }] };
  }
}
