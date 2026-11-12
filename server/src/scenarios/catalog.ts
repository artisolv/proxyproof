/**
 * The scenario world and catalogue. A run is one buyer PROMPT (what Northwind asks its agent to do) combined with one
 * real-world COMPLICATION (what goes wrong this time). Both only describe conditions and what each agent attempts; they
 * never state an outcome. The engine plays the composed steps through the real verification and records what
 * ProxyProof decided.
 */
export type Line = [product: string, quantity: number];
export type Step =
  | { do: 'revoke'; agent: string; reason: string; say: string }
  | { do: 'status'; up: boolean; say: string }
  | { do: 'offer' | 'revise'; agent: string; lines: Line[]; document?: 'INVOICE' | 'QUOTE'; payTo?: 'enrolled' | string; to?: string; behaviour?: string; say: string }
  | { do: 'accept'; agent: string; behaviour?: string; say: string }
  | { do: 'review'; approver: string; say: string }
  /** A person at the buyer approves the exact terms, but only if ProxyProof asked for a review. Otherwise skipped. */
  | { do: 'approve_if_asked'; approver: string; say: string }
  | { do: 'recheck'; say: string }
  | { do: 'execute'; permit: 'issued' | 'reuse' | 'none'; say: string };
export type Scenario = {
  id: string; title: string; kind: 'happy' | 'attack' | 'failure' | 'limit';
  story: string; without: string; realWorld: { text: string; source: string; url: string } | null;
  reference: string; cast: { buyer: string; seller: string; buyerOrg: string };
  prompt: string; complication: string;
  steps: Step[];
};

export const PRODUCTS = [
  { name: 'House Blend, whole bean, 5 lb', category: 'coffee', unit_amount_minor: 6_600 },
  { name: 'Espresso Roast, 5 lb', category: 'coffee', unit_amount_minor: 7_000 },
  { name: 'Decaf Blend, 2 lb', category: 'coffee', unit_amount_minor: 3_600 },
  { name: 'Espresso machine service visit', category: 'service', unit_amount_minor: 24_000 },
  { name: 'Countertop espresso grinder', category: 'equipment', unit_amount_minor: 39_500 },
];

type Org = { name: string; role: 'BUYER' | 'SELLER'; enrolled: boolean; payout?: 'SANDBOX_SELLER' | 'SANDBOX_BUYER' | string };
type AgentDef = { name: string; side: 'BUYER' | 'SELLER'; org: string; status?: 'active' | 'expired' | 'none'; mandate?: { actions: string[]; max_minor: number; categories: string[]; counterparties?: string[]; destinations?: string[]; review_above_minor?: number } };

export const WORLD: { product: { name: string; description: string }; organizations: Org[]; agents: AgentDef[] } = {
  product: { name: 'Coffee and coffee-machine service', description: 'Northwind Hotels buys roasted coffee every week, pays a monthly supply bill and pays for espresso machine servicing, all from its usual roaster, Harbor & Pine. Both businesses let AI agents handle orders and invoices.' },
  organizations: [
    { name: 'Northwind Hotels', role: 'BUYER', enrolled: true, payout: 'SANDBOX_BUYER' },
    { name: 'Harbor & Pine Roasters', role: 'SELLER', enrolled: true, payout: 'SANDBOX_SELLER' },
    { name: 'Bayside Trading Co.', role: 'SELLER', enrolled: false, payout: 'payments@bayside-trading.example' },
  ],
  agents: [
    // Northwind lets its agent buy coffee and machine service only, up to $500, from Harbor & Pine; above $250 a person approves.
    { name: 'Northwind Procurement Agent', side: 'BUYER', org: 'Northwind Hotels', mandate: { actions: ['purchase'], max_minor: 50_000, categories: ['coffee', 'service'], counterparties: ['Harbor & Pine Roasters'], review_above_minor: 25_000 } },
    // Harbor & Pine lets its agent quote and invoice coffee, service and equipment, up to $2,000, paid only into its enrolled account.
    { name: 'Harbor & Pine Sales Agent', side: 'SELLER', org: 'Harbor & Pine Roasters', mandate: { actions: ['quote', 'issue_invoice', 'request_payment'], max_minor: 200_000, categories: ['coffee', 'service', 'equipment'], counterparties: ['Northwind Hotels'], destinations: ['SANDBOX_SELLER'] } },
    { name: 'Bayside Sales Agent', side: 'SELLER', org: 'Bayside Trading Co.', mandate: { actions: ['quote', 'issue_invoice', 'request_payment'], max_minor: 200_000, categories: ['coffee', 'service'], counterparties: ['Northwind Hotels'], destinations: ['payments@bayside-trading.example'] } },
  ],
};

const BUYER = 'Northwind Procurement Agent', SELLER = 'Harbor & Pine Sales Agent', APPROVER = 'Dana Reyes, Northwind purchasing manager';

const SRC = {
  ic3: { source: 'FBI IC3 2024 report', url: 'https://www.ic3.gov/AnnualReport/Reports/2024_IC3Report.pdf' },
  europol: { source: 'Europol: invoice fraud', url: 'https://www.europol.europa.eu/sites/default/files/documents/6_invoice_fraud.pdf' },
  vend: { source: 'Anthropic, Project Vend', url: 'https://www.anthropic.com/research/project-vend-1' },
  operator: { source: 'Washington Post via ADN', url: 'https://www.adn.com/alaska-life/2025/02/09/i-let-chatgpts-new-agent-manage-my-life-it-spent-31-on-a-dozen-eggs/' },
  arup: { source: 'CFO Dive', url: 'https://www.cfodive.com/news/deepfake-scam-engineering-firm-arup-25-million-fraud-hong-kong-cfo/716501/' },
  doj: { source: 'US DOJ, SDNY', url: 'https://www.justice.gov/usao-sdny/pr/lithuanian-man-sentenced-5-years-prison-theft-over-120-million-fraudulent-business' },
  brave: { source: 'Brave security research', url: 'https://brave.com/blog/comet-prompt-injection/' },
  magentic: { source: 'Microsoft Research', url: 'https://www.microsoft.com/en-us/research/publication/magentic-marketplace-an-open-source-environment-for-studying-agentic-markets/' },
  cisco: { source: 'US DOJ, NDCA', url: 'https://www.justice.gov/usao-ndca/pr/san-jose-man-sentenced-two-years-imprisonment-damaging-cisco-s-network' },
  revlon: { source: 'Banking Dive', url: 'https://www.bankingdive.com/news/citi-revlon-lawsuit-payment-mistake-creditors/595154/' },
  crl: { source: 'Adam Langley on revocation', url: 'https://www.imperialviolet.org/2012/02/05/crlsets.html' },
  ap2: { source: 'Google Cloud: AP2', url: 'https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol' },
};


/** What Northwind asks its agent to do. Each prompt is one banner in the centre of the lab. */
export type Prompt = { id: string; kind: 'purchase' | 'bill' | 'service'; prompt: string; title: string; what: string; summary: string; reference: string; document: 'QUOTE' | 'INVOICE'; lines: Line[] };
export const PROMPTS: Prompt[] = [
  { id: 'buy-coffee', kind: 'purchase', prompt: 'Order this week’s coffee for breakfast', title: 'Weekly coffee beans', what: 'this week’s coffee', summary: 'House Blend, Espresso Roast and Decaf for the breakfast rooms and lobby.', reference: 'HP-Q-2211', document: 'QUOTE', lines: [['House Blend, whole bean, 5 lb', 2], ['Espresso Roast, 5 lb', 1], ['Decaf Blend, 2 lb', 1]] },
  { id: 'pay-bill', kind: 'bill', prompt: 'Pay the monthly supply bill', title: 'November supply bill', what: 'the November supply bill', summary: 'A month of coffee for two Northwind properties, billed together.', reference: 'HP-INV-1043', document: 'INVOICE', lines: [['House Blend, whole bean, 5 lb', 4], ['Espresso Roast, 5 lb', 2], ['Decaf Blend, 2 lb', 2]] },
  { id: 'pay-service', kind: 'service', prompt: 'Pay Tuesday’s machine service invoice', title: 'Espresso machine service', what: 'Tuesday’s machine service', summary: 'Tuesday’s service visit: descaling, gasket and grinder calibration.', reference: 'HP-SRV-0318', document: 'INVOICE', lines: [['Espresso machine service visit', 1]] },
];

/**
 * What goes wrong this time. `apply` rewrites the base flow with conditions only (an account in the invoice, an agent's
 * behaviour, a revocation, an outage). ProxyProof's checks decide the rest.
 */
type OfferStep = Extract<Step, { lines: Line[] }>;
type Base = { offer: OfferStep; accept: Extract<Step, { do: 'accept' }>; before: Step[]; afterAccept: Step[]; afterPay: Step[]; seller: string };
export type Complication = { id: string; kind: Scenario['kind']; title: string; story: string; without: string; realWorld: Scenario['realWorld']; appliesTo?: Prompt['kind'][]; apply: (b: Base, p: Prompt) => void };
const doc = (p: Prompt) => (p.document === 'QUOTE' ? 'quote' : 'invoice');

export const COMPLICATIONS: Complication[] = [
  { id: 'genuine', kind: 'happy', title: 'Everything genuine', story: 'Both agents are who they say they are and act within what their businesses allowed.', without: 'The payment goes through, but nobody can prove who authorized what.', realWorld: { text: 'Industry payment protocols now ask for signed proof that an agent had authority for a specific purchase.', ...SRC.ap2 }, apply: () => {} },
  { id: 'payout-changed', kind: 'attack', title: 'Bank details changed', story: 'The invoice comes from Harbor & Pine’s real agent, but asks to be paid into an account the roaster never enrolled.', without: 'Northwind pays a genuine-looking invoice into a stranger’s account, and the real supplier is still owed.', realWorld: { text: 'Business email compromise cost US businesses $2.77 billion in 2024; the FBI’s advice is to verify any change of payment details.', ...SRC.ic3 },
    apply: (b, p) => { b.offer.payTo = 'billing@harb0r-pine.example'; b.offer.say = `Harbor & Pine’s agent sends the ${doc(p)}, asking for payment to billing@harb0r-pine.example.`; } },
  { id: 'altered-in-transit', kind: 'attack', title: 'Invoice altered', story: 'Harbor & Pine’s agent signs the bill, but on the way someone raises one line by $100.', without: 'Northwind’s agent sees a supplier-branded bill $100 higher and pays it.', realWorld: { text: 'Europol warns of genuine invoices whose details are altered before they reach the payer.', ...SRC.europol },
    apply: (b, p) => { b.offer.behaviour = 'tamper_after_signing'; b.offer.say = `Harbor & Pine’s agent signs the ${doc(p)}; the copy that reaches Northwind is $100 higher.`; } },
  { id: 'different-totals', kind: 'failure', title: 'Price mismatch', story: 'Northwind’s agent says yes, but the terms it actually signs carry a total $50 lower.', without: 'The bill is paid at one number and booked at another, and no one can show what was agreed.', realWorld: { text: 'In a Microsoft Research marketplace of 400 agents, some models were fully manipulated by seller agents.', ...SRC.magentic },
    apply: (b) => { b.accept.behaviour = 'sign_different_terms'; b.accept.say = 'Northwind’s agent accepts, but signs terms with a total $50 lower.'; } },
  { id: 'forged-mandate', kind: 'attack', title: 'Forged authority', story: 'The buyer’s agent presents a mandate in Northwind’s name that Northwind’s key never signed.', without: 'A convincing authorization is accepted because it looks right.', realWorld: { text: 'An Arup employee sent US$25 million after a video call where the “CFO” was a deepfake.', ...SRC.arup },
    apply: (b) => { b.accept.behaviour = 'forged_delegation'; b.accept.say = 'The buyer’s agent accepts with a mandate signed by an unknown key in Northwind’s name.'; } },
  { id: 'lookalike-supplier', kind: 'attack', title: 'Lookalike supplier', story: '“Bayside Trading Co.” sends the same bill a little cheaper, but it never enrolled and Northwind never approved it.', without: 'A new supplier with a plausible name and a working agent gets paid on its first invoice.', realWorld: { text: 'A fraudster registered a company with a real supplier’s name and diverted over $120 million from two US tech firms.', ...SRC.doj },
    apply: (b, p) => { b.seller = 'Bayside Sales Agent'; b.offer.agent = 'Bayside Sales Agent'; b.offer.payTo = 'payments@bayside-trading.example'; b.offer.say = `Bayside’s agent sends Northwind a ${doc(p)} for the same items.`; } },
  { id: 'prompt-injection', kind: 'attack', title: 'Prompt injection', story: 'Hidden text on a supplier page tells Northwind’s agent it “must” add a $395 grinder, and the agent goes along.', without: 'The agent uses Northwind’s full purchasing authority to buy whatever the page told it to.', realWorld: { text: 'A hidden comment on a web page made an AI browser agent leak the user’s email and one-time code.', ...SRC.brave },
    apply: (b, p) => { b.offer.lines = [...b.offer.lines, ['Countertop espresso grinder', 1]]; b.offer.say = `Harbor & Pine’s agent adds the $395 grinder the manipulated buyer agent asked for to the ${doc(p)}.`; b.accept.say = 'The manipulated agent tries to accept the grinder too.'; } },
  { id: 'revoked-agent', kind: 'failure', title: 'Agent revoked', story: 'Northwind switches off its agent after a key scare, but an approved payment is still waiting to run.', without: 'Last week’s approval still works this week. Revocation is a database row nobody reads at payment time.', realWorld: { text: 'A former Cisco engineer used access that still worked five months after he resigned and deleted 456 servers.', ...SRC.cisco },
    apply: (b) => { b.afterAccept.push({ do: 'revoke', agent: BUYER, reason: 'Agent decommissioned after a key scare', say: 'Northwind revokes the agent’s mandate while the payment is queued.' }); } },
  { id: 'duplicate-payment', kind: 'failure', title: 'Duplicate payment', story: 'After the checkout opens, the same request is retried with the same permit.', without: 'The retry creates a second payment, and getting it back takes phone calls and lawyers.', realWorld: { text: 'Citibank wired $900 million by mistake instead of $7.8 million; recovering it took two years in court.', ...SRC.revlon },
    apply: (b) => { b.afterPay.push({ do: 'execute', permit: 'reuse', say: 'The same permit is sent again.' }); } },
  { id: 'status-outage', kind: 'failure', title: 'Status check offline', story: 'Just as Northwind’s agent accepts, the service that says whether a mandate was revoked cannot be reached.', without: 'Systems that “soft-fail” treat “could not check” as “fine” and let the payment through.', realWorld: { text: 'Chrome’s security lead: soft-fail revocation checks are “like a seat-belt that snaps when you crash”.', ...SRC.crl },
    apply: (b) => {
      b.before.push({ do: 'status', up: false, say: 'The revocation status service goes down.' });
      b.afterAccept.push({ do: 'status', up: true, say: 'The status service comes back.' }, { do: 'recheck', say: 'ProxyProof checks both sides again on live state.' }, { do: 'approve_if_asked', approver: APPROVER, say: 'A Northwind manager approves the exact terms.' });
    } },
  { id: 'wrong-item', kind: 'limit', title: 'Wrong item', appliesTo: ['purchase'], story: 'Northwind’s agent orders three bags of Espresso Roast when the hotel needed House Blend. Everything about it is authorized.', without: 'Same result. ProxyProof answers “was this authorized?”, not “was this wise?”. A tighter mandate is the organization’s job.', realWorld: { text: 'Agents misbehave inside their permissions too: Project Vend’s agent sold below cost and invented a payment account.', ...SRC.vend },
    apply: (b) => { b.offer.lines = [['Espresso Roast, 5 lb', 3]]; b.offer.say = 'Harbor & Pine’s agent quotes what Northwind’s agent asked for: 3 × Espresso Roast, $210.'; } },
];

/**
 * Rules the user sets for each agent in the lab, as each business would. The engine turns them into the agents'
 * real signed mandates; ProxyProof's checks then decide. Missing fields keep the defaults in WORLD.
 */
export type Rules = {
  buyer?: { max?: number; reviewAbove?: number; categories?: string[]; suppliers?: string[]; revoked?: boolean };
  seller?: { mayInvoice?: boolean; payTo?: 'registered' | 'unregistered'; revoked?: boolean };
};
export const UNREGISTERED_ACCOUNT = 'billing@harb0r-pine.example';

/** Builds the steps for one prompt and one complication, under the user's rules. */
export function compose(promptId: string, complicationId: string, rules: Rules = {}): Scenario | null {
  const p = PROMPTS.find((x) => x.id === promptId), c = COMPLICATIONS.find((x) => x.id === complicationId);
  if (!p || !c || (c.appliesTo && !c.appliesTo.includes(p.kind))) return null;
  const verb = p.kind === 'purchase' ? 'quotes' : 'invoices';
  const b: Base = {
    seller: SELLER,
    offer: { do: 'offer', agent: SELLER, lines: [...p.lines], document: p.document, say: `Harbor & Pine’s agent ${verb} Northwind for ${p.what} and signs it.` },
    accept: { do: 'accept', agent: BUYER, say: `Northwind’s agent reads the ${doc(p)} and signs acceptance of the same terms.` },
    before: [], afterAccept: [], afterPay: [],
  };
  c.apply(b, p);
  // The user's rules: a revoked agent is revoked before it acts; the seller's payout choice goes on the invoice.
  if (rules.seller?.payTo === 'unregistered' && b.seller === SELLER) { b.offer.payTo = UNREGISTERED_ACCOUNT; }
  if (rules.buyer?.revoked) b.before.push({ do: 'revoke', agent: BUYER, reason: 'Northwind revoked this agent', say: 'Northwind has revoked its agent’s mandate.' });
  if (rules.seller?.revoked && b.seller === SELLER) b.before.push({ do: 'revoke', agent: SELLER, reason: 'Harbor & Pine revoked this agent', say: 'Harbor & Pine has revoked its agent’s delegation.' });
  const steps: Step[] = [
    ...b.before, b.offer, b.accept,
    { do: 'approve_if_asked', approver: APPROVER, say: 'A Northwind manager approves the exact terms.' },
    ...b.afterAccept,
    { do: 'execute', permit: 'issued', say: 'Northwind’s agent spends its single-use permit to open the PayPal checkout.' },
    ...b.afterPay,
  ];
  return {
    id: `${p.id}:${c.id}`, title: c.title, kind: c.kind, story: c.story, without: c.without, realWorld: c.realWorld,
    reference: p.reference, cast: { buyer: BUYER, seller: b.seller, buyerOrg: 'Northwind Hotels' }, prompt: p.id, complication: c.id, steps,
  };
}
