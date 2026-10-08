import type { Reward } from "../game/rewards";
import { PurchaseError } from "./store";
export interface ProductGrant {
  rewards: Reward[];
  entitlements: Record<string, string>;
  oneTimeKey?: string;
}
const flags = (...keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, "1"]));
const currency = (ruby: number, gold = 0): Reward[] => [
  { id: "ruby", amount: ruby },
  ...(gold ? [{ id: "gold", amount: gold }] : []),
];
const material = (id: string, amount: number): Reward => ({
  id,
  amount,
  itemCategory: 1,
});
const potion = (id: string, amount: number): Reward => ({
  id,
  amount,
  itemCategory: 2,
});
const jewels = (amount: number) =>
  ["protection", "endurance", "courage"].map((kind) =>
    material(`jewel_${kind}_e`, amount),
  );
const logical: Record<string, ProductGrant> = {
  premium: { rewards: [], entitlements: flags("premium") },
  archer: { rewards: [], entitlements: flags("louisaUnlock") },
  souru: { rewards: [], entitlements: flags("soulUnlock") },
  double_loot: { rewards: [], entitlements: flags("double_loot") },
  more_exp: { rewards: [], entitlements: flags("more_exp") },
  starter: {
    rewards: currency(150, 150000),
    entitlements: flags("premium", "getOffer"),
    oneTimeKey: "getOffer",
  },
  booster_pack: {
    rewards: [],
    entitlements: flags("more_exp", "double_loot", "dualTaken"),
  },
  stepup_1: {
    rewards: [
      ...currency(100, 1000000),
      material("ironbar", 100),
      material("cloth", 100),
      material("voids", 50),
      ...jewels(15),
      potion("medred", 20),
      potion("medblue", 20),
      material("shining_gem", 30),
    ],
    entitlements: flags("stepUp1"),
    oneTimeKey: "stepUp1",
  },
  stepup_2: {
    rewards: [
      ...currency(200, 2000000),
      material("silverbar", 100),
      material("fabric", 100),
      material("wind", 50),
      ...jewels(20),
      potion("maxred", 20),
      potion("maxblue", 20),
      material("shining_gem", 50),
    ],
    entitlements: flags("stepUp2"),
    oneTimeKey: "stepUp2",
  },
  stepup_3: {
    rewards: [
      ...currency(300, 5000000),
      material("goldbar", 100),
      material("hide", 100),
      material("water", 50),
      ...jewels(30),
      potion("maxred", 30),
      potion("maxblue", 30),
      material("radiant_gem", 20),
    ],
    entitlements: flags("stepUp3"),
    oneTimeKey: "stepUp3",
  },
  stepup_4: {
    rewards: [
      ...currency(500, 10000000),
      material("titaniumbar", 100),
      material("leather", 100),
      material("fire", 100),
      ...jewels(50),
      potion("maxred", 50),
      potion("maxblue", 50),
      material("radiant_gem", 30),
    ],
    entitlements: flags("stepUp4"),
    oneTimeKey: "stepUp4",
  },
  stepup_5: {
    rewards: [
      ...currency(500, 15000000),
      material("relic_frag_a", 100),
      material("relic_frag_w", 100),
      material("shining_gem", 50),
      material("radiant_gem", 30),
      ...jewels(50),
      potion("maxred", 50),
      potion("maxblue", 50),
    ],
    entitlements: flags("stepUp5"),
    oneTimeKey: "stepUp5",
  },
};
for (const [index, amount] of [9, 32, 100, 200, 400, 800, 1600, 3200].entries())
  logical[`ruby${index + 1}`] = { rewards: currency(amount), entitlements: {} };
for (const [sku, indices] of Object.entries({
  xmas_pack: [1, 1, 1, 2],
  brave_pack: [2, 2, 2, 3],
  lny_pack: [3, 3, 3, 4],
  date_pack_b: [4, 4, 4, 1],
  elysian_pack: [5, 5, 5, 5],
}))
  logical[sku] = {
    rewards: [],
    entitlements: flags(
      ...["alaster", "edna", "louisa", "soul"].map(
        (c, i) => `costume_${c}_${indices[i]}`,
      ),
      ...(sku === "elysian_pack" ? ["elysianTaken"] : []),
    ),
  };
for (const kind of ["courage", "protection", "endurance"])
  logical[
    `jewel_${({ courage: "red", protection: "orange", endurance: "purple" } as Record<string, string>)[kind]}`
  ] = {
    rewards: [
      material(`jewel_${kind}_c`, 10),
      material(`jewel_${kind}_r`, 10),
      material(`jewel_${kind}_e`, 5),
    ],
    entitlements: {},
  };
for (const [name, char] of Object.entries({
  alaster: "alaster",
  edna: "edna",
  louisa: "louisa",
  zerav: "soul",
}))
  for (const [kind, index] of [
    ["red", 6],
    ["dark", 7],
  ] as const)
    logical[`wyvern_${kind}_${name}`] = {
      rewards: [],
      entitlements: flags(`costume_${char}_${index}`),
    };
const iosAliases: Record<string, string> = {
  iap_premium: "premium",
  iap_starter: "starter",
  iap_xmas_pack: "xmas_pack",
  iap_brave_pack: "brave_pack",
  iap_lny_pack: "lny_pack",
  iap_date_pack: "date_pack_b",
  iap_elysian_pack: "elysian_pack",
  iap_double_loot: "double_loot",
  iap_more_exp: "more_exp",
  iap_dual_booster: "booster_pack",
  iap_archer: "archer",
  iap_souru: "souru",
  ...Object.fromEntries(
    [1, 2, 3, 4, 5].map((i) => [`iap_stepup_${i}`, `stepup_${i}`]),
  ),
};
export function productGrant(
  platform: "google" | "apple",
  productId: string,
): ProductGrant {
  const key =
    platform === "apple"
      ? iosAliases[productId] ||
        (/^(ruby[1-8]|jewel_(red|orange|purple))$/.test(productId)
          ? productId
          : "")
      : productId;
  const product = Object.hasOwn(logical, key) ? logical[key] : undefined;
  if (!product) throw new PurchaseError("purchase_product_unsupported", 422);
  return structuredClone(product);
}
