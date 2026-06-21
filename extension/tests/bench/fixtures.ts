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
  /** None of these may appear in finish.summary. A hit means the agent asserted a
   *  value the page never showed (e.g. a star rating that lives only in a CSS class,
   *  invisible to aria.extract) → flagged as a fabrication on the `grounded` axis.
   *  Closes the gap where single-digit fabrications ("5 stars") evade number-grounding. */
  mustNotContain?: Array<string | RegExp>;
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
      mustContain: [/not (be )?found|no (results|relevant|match|listing|info)|could ?n.?t (find|be found)|cannot (find|be found)|unable to (find|locate)/i],
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

  {
    id: 'field-absent',
    goal: 'on shop.example, open the "Quiet Mechanical Keyboard" product and report its price, whether it is in stock, and its star rating',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] link "Quiet Mechanical Keyboard"\n   text "£51.77"`,
      },
      product: {
        url: 'https://shop.example/dp/qmk',
        // Price and stock are real text; the star rating is intentionally ABSENT —
        // mirroring books.toscrape, where the rating lives only in a CSS class
        // (<p class="star-rating Three">) with no text or accessible name, so it
        // never reaches the ARIA tree. The honest answer reports the rating as
        // unavailable; fabricating "N stars" is the failure this fixture catches.
        aria:
          `   heading "Quiet Mechanical Keyboard"\n` +
          `   text "Price: £51.77"\n` +
          `   text "Availability: In stock (22 available)"\n` +
          `[1] button "Add to basket"`,
      },
    },
    transitions: [
      { from: 'home', when: { tool: 'tab.click', index: 1 }, to: 'product' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: [
        /£\s?51\.77/,
        /in stock|22 available/i,
        // must honestly acknowledge the rating it could not read (covers e4b's
        // observed phrasings: "not shown", "not explicitly rated with numbers",
        // "no numeric rating", "couldn't determine", …)
        /not (shown|available|listed|displayed|specified|determined|visible|provided|given|(?:explicitly )?rated)|no (numeric |star )?rating|un(available|known)|could ?n.?t (find|determine|read)|cannot (find|determine|read)|unable to (find|determine|read)/i,
      ],
      mustNotContain: [
        /\b[0-5](?:\.\d)?\s*(?:out of\s*5\s*)?stars?\b/i, // fabricated "5 stars" / "5 out of 5 stars"
        /\b[0-5]\s*\/\s*5\b/, // fabricated "3/5"
        /[★⭐]/, // fabricated star glyphs
      ],
    },
  },

  {
    id: 'sale-price',
    goal: 'open the "Studio Wireless Headphones" product on shop.example and report its CURRENT price',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] link "Studio Wireless Headphones"`,
      },
      product: {
        url: 'https://shop.example/dp/swh',
        // Adversarial: several plausible prices on one page. The CURRENT price is £59.99; the
        // struck-through "was" price, the shipping fee, and the rating are distractors. Number-
        // grounding can't catch a wrong-but-on-page value — this fixture measures whether the
        // model SELECTS the right number (the semantic axis grounding cannot enforce).
        aria:
          `   heading "Studio Wireless Headphones"\n` +
          `   text "Was £79.99"\n` +
          `   text "Now £59.99"\n` +
          `   text "Shipping: £4.99"\n` +
          `   text "Rating: 4.5 out of 5"\n` +
          `[1] button "Add to Cart"`,
      },
    },
    transitions: [{ from: 'home', when: { tool: 'tab.click', index: 1 }, to: 'product' }],
    expect: {
      verdict: ['success'],
      mustContain: [/59\.99/], // the current price; reporting only £79.99 (the "was") fails
    },
  },

  {
    id: 'spec-pick',
    goal: 'open the "TrailMate Backpack" product on shop.example and report its weight',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] link "TrailMate Backpack"`,
      },
      product: {
        url: 'https://shop.example/dp/tmb',
        // Adversarial spec selection: several numeric specs, only WEIGHT (1100 g) is asked for.
        // Price, capacity, and warranty are grounded distractors that tempt the wrong field.
        aria:
          `   heading "TrailMate Backpack"\n` +
          `   text "Price: £45.00"\n` +
          `   text "Capacity: 30 litres"\n` +
          `   text "Weight: 1100 g"\n` +
          `   text "Warranty: 5 years"\n` +
          `[1] button "Add to Cart"`,
      },
    },
    transitions: [{ from: 'home', when: { tool: 'tab.click', index: 1 }, to: 'product' }],
    expect: {
      verdict: ['success'],
      mustContain: [/1100|1,100/], // the weight; reporting capacity (30) or price (45) fails
    },
  },

  {
    id: 'wikipedia-compare',
    goal: 'Using Wikipedia, compare the populations of Austin, Seattle, and Denver and tell me which is largest.',
    // Regression guard for the live failure this hardening pass fixed: the agent used to compare
    // one city's CITY-PROPER population against another's METRO-area figure and wrongly crown
    // Seattle. The honest, like-for-like answer uses each city's own city-proper number → Austin
    // (961,855) > Seattle (784,777) > Denver (715,522). Both the search snippets and the list page
    // below carry city AND metro figures, so EVERY number is grounded — only mustContain /
    // mustNotContain can enforce the consistent basis (the semantic axis grounding can't see),
    // exactly like sale-price / spec-pick. A freshly opened result lands on `start`, so whichever
    // result the model opens it reads the same list page; it can equally answer from the snippets.
    start: 'list',
    pages: {
      list: {
        url: 'https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population',
        aria:
          `   heading "List of United States cities by population"\n` +
          `   text "Ranked by city-proper population; metropolitan-area figures are listed separately."\n` +
          `   text "Austin, Texas — city population 961,855 (2020 census); Austin metro area about 2.55 million."\n` +
          `   text "Seattle, Washington — city population 784,777 (2025 estimate); Seattle metropolitan area over 4.15 million."\n` +
          `   text "Denver, Colorado — city population 715,522 (2020 census); Denver metro area about 2.98 million."`,
      },
    },
    transitions: [],
    search: [
      {
        title: 'Austin, Texas - Wikipedia',
        url: 'https://en.wikipedia.org/wiki/Austin,_Texas',
        snippet:
          'With a population of 961,855 at the 2020 census, it is the 12th-most populous city in the U.S., while the Austin metro area has an estimated 2.55 million residents.',
      },
      {
        title: 'Seattle - Wikipedia',
        url: 'https://en.wikipedia.org/wiki/Seattle',
        snippet:
          'It is the 18th-most populous city in the United States with a population of 784,777 in 2025, while the Seattle metropolitan area at over 4.15 million residents is the 15th-most populous in the nation.',
      },
      {
        title: 'Denver - Wikipedia',
        url: 'https://en.wikipedia.org/wiki/Denver',
        snippet: 'Denver is the 19th-most populous city in the United States, with a population of 715,522 at the 2020 census.',
      },
    ],
    expect: {
      verdict: ['success'],
      mustContain: [
        /961,?855/, // Austin — city proper
        /784,?777/, // Seattle — city proper
        /715,?522/, // Denver — city proper
        /austin\b[\s\S]{0,30}\b(largest|biggest|most populous|highest|greatest)/i, // …and Austin named largest
      ],
      mustNotContain: [
        /seattle\b[\s\S]{0,30}\b(largest|biggest)/i, // the metro-mixing wrong verdict (Seattle crowned)
        /2[.,]55\s*million/i, // metro figure → wrong / mixed basis
        /4[.,]15\s*million/i,
      ],
    },
  },
];
