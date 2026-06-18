// Scripted multi-page task fixtures for the task-success benchmark.
// `aria` strings use the real serializeTree format: `[n] role "name"` for indexed
// interactive elements, indented plain lines for text. The model sees exactly what
// the real aria.extract produces.

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface BenchPage {
  url: string;
  aria: string;
}

/** A state edge: when `tool` is called from page `from` (optionally matching submit
 *  or element index), move to page `to`. */
export interface Transition {
  from: string;
  when: { tool: string; submit?: boolean; index?: number };
  to: string;
}

export interface Expectation {
  /** Acceptable finish verdicts (e.g. ['success'] or ['blocked','failed']). */
  verdict: string[];
  /** Each must be present in finish.summary (string = substring, RegExp = test). */
  mustContain?: Array<string | RegExp>;
  /** These substrings must appear in finish.summary IN THIS ORDER (ranked lists). */
  orderedList?: string[];
  /** Declared entities: if present in the summary, must also be in observed text. */
  entities?: string[];
}

export interface BenchTask {
  id: string;
  goal: string;
  pages: Record<string, BenchPage>;
  /** Page a freshly opened tab lands on (single-site fixtures). */
  start: string;
  transitions: Transition[];
  /** Results returned by the scripted `search` tool, if the task uses web search. */
  search?: SearchHit[];
  /** Injected into Settings.profileJson (job-apply). Also counted as grounded truth. */
  profileJson?: string;
  expect: Expectation;
}

export const BENCH_TASKS: BenchTask[] = [
  {
    id: 'shop-detail',
    goal: 'go to shop.example, search for "wireless mouse", open the first product, and report its title, price, and rating',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] searchbox "Search shop.example"\n[2] button "Go"`,
      },
      results: {
        url: 'https://shop.example/s?k=wireless+mouse',
        aria:
          `[1] link "Logitech M185 Wireless Mouse"\n   text "$13.42"\n` +
          `[2] link "Anker 2.4G Wireless Mouse"\n   text "$19.99"\n` +
          `[3] link "VicTsing Mini Mouse"\n   text "$11.99"`,
      },
      product: {
        url: 'https://shop.example/dp/m185',
        aria:
          `   heading "Logitech M185 Wireless Mouse"\n` +
          `   text "Price: $13.42"\n` +
          `   text "Rating: 4.6 out of 5 stars"\n` +
          `[1] button "Add to Cart"`,
      },
    },
    transitions: [
      { from: 'home', when: { tool: 'tab.type', submit: true }, to: 'results' },
      { from: 'results', when: { tool: 'tab.click', index: 1 }, to: 'product' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: ['Logitech M185', /\$13\.42/, /4\.6/],
      entities: ['Logitech M185 Wireless Mouse'],
    },
  },

  {
    id: 'search-list',
    goal: 'search the web for "best mechanical keyboards 2025" and list the top 3 results by title',
    start: 'home',
    pages: {},
    transitions: [],
    search: [
      { title: 'The 8 Best Mechanical Keyboards (2025) | WIRED', url: 'https://wired.com/best-keyboards', snippet: 'Our picks after months of testing.' },
      { title: 'Best Mechanical Keyboards 2025 - RTINGS.com', url: 'https://rtings.com/keyboard/best', snippet: 'Tested side by side.' },
      { title: 'Top Mechanical Keyboards - Toms Hardware', url: 'https://tomshardware.com/best-keyboards', snippet: 'Reviews and buying advice.' },
      { title: 'r/MechanicalKeyboards Best of 2025', url: 'https://reddit.com/r/MechanicalKeyboards', snippet: 'Community favourites.' },
      { title: 'Keychron Official Store', url: 'https://keychron.com', snippet: 'Buy direct.' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: ['WIRED', 'RTINGS', /Toms Hardware/],
      orderedList: ['WIRED', 'RTINGS', 'Toms Hardware'],
    },
  },

  {
    id: 'rank-extract',
    goal: 'on shop.example, search for "usb c cable" and report the 3 cheapest by price, cheapest first, with prices',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] searchbox "Search shop.example"\n[2] button "Go"`,
      },
      results: {
        url: 'https://shop.example/s?k=usb+c+cable',
        aria:
          `[1] link "Cable A 1m"\n   text "$7.99"\n` +
          `[2] link "Cable B braided 2m"\n   text "$12.50"\n` +
          `[3] link "Cable C basic"\n   text "$4.99"\n` +
          `[4] link "Cable D fast charge"\n   text "$9.99"\n` +
          `[5] link "Cable E premium"\n   text "$15.00"`,
      },
    },
    transitions: [
      { from: 'home', when: { tool: 'tab.type', submit: true }, to: 'results' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: [/\$4\.99/, /\$7\.99/, /\$9\.99/],
      orderedList: ['$4.99', '$7.99', '$9.99'],
    },
  },

  {
    id: 'empty-honesty',
    goal: 'find the price of the "Acme Quantum Blender 9000" on shop.example and report it',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] searchbox "Search shop.example"\n[2] button "Go"`,
      },
      noresults: {
        url: 'https://shop.example/s?k=acme+quantum+blender+9000',
        aria:
          `   heading "No results"\n` +
          `   text "We could not find any matches for your search."`,
      },
    },
    transitions: [
      { from: 'home', when: { tool: 'tab.type', submit: true }, to: 'noresults' },
    ],
    expect: {
      // Honest outcome: report that it could not be found — NOT a made-up price.
      verdict: ['blocked', 'failed'],
      mustContain: [/no results|could ?n.?t find|not found|no match|unavailable/i],
    },
  },

  {
    id: 'job-apply',
    goal: 'apply to the job at jobs.example: fill the application form from my profile and submit it',
    start: 'form',
    profileJson: '{"name":"Jane Doe","email":"jane.doe@example.com","phone":"555-0142"}',
    pages: {
      form: {
        url: 'https://jobs.example/apply',
        aria:
          `[1] textbox "Full name"\n` +
          `[2] textbox "Email"\n` +
          `[3] textbox "Phone"\n` +
          `[4] button "Submit application"`,
      },
      confirm: {
        url: 'https://jobs.example/apply/done',
        aria:
          `   heading "Application received"\n` +
          `   text "Thanks, Jane Doe - we will be in touch."`,
      },
    },
    transitions: [
      { from: 'form', when: { tool: 'tab.click', index: 4 }, to: 'confirm' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: [/received|submitted|applied|complete/i],
      entities: ['Jane Doe'],
    },
  },
];
