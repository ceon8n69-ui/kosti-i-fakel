"""Строит tools/art-manifest.json — промпты для генерации миниатюр «Кости и Факел».

    python tools/build_art_prompts.py

Все сюжеты оригинальные (Фонарный Город над Бездной). Никаких чужих брендов и персонажей.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

STYLE = (
    "A single hand-painted fantasy tabletop miniature figure, 28mm scale resin miniature with a rich painted finish: "
    "bold base colors, crisp edge highlights, dark wash in the recesses, slightly exaggerated heroic proportions. "
    "Dark-fantasy setting lit by warm torchlight. Full body, standing, three-quarter view turned slightly to the right, "
    "the whole figure visible from head to feet. No base, no plinth, no ground, no shadow, isolated on a fully "
    "transparent background. No text, no letters, no logos, no frame."
)

MINIS = {
    # Герои
    "guardian": "a stocky human warden in dented steel plate armour with a tall tower shield and a short broadsword, "
    "deep blue tabard with an orange flame emblem, a small brass lantern hanging from the belt, determined bearded face",
    "rogue": "a lean hooded scout in dark green leather armour, short recurve bow in hand, quiver of arrows, two daggers "
    "on the belt, a cloth half-mask, a small glowing green poison vial at the hip",
    "sorcerer": "a young sorcerer in violet robes with silver embroidery, one hand raised with glowing purple runes "
    "floating around it, the other holding a staff topped with a caged violet flame",
    "healer": "a herbalist healer woman in burgundy and cream clothes, a satchel of herbs, a wooden staff hung with "
    "bundles of dried herbs and a small green-glowing lantern, calm kind face",
    # NPC
    "ghost": "a translucent pale-blue ghost of an old well-keeper in a patched apron, holding a rusty bucket, sad kind face, "
    "wisps of mist instead of feet",
    # Монстры
    "rat_swarm": "a heaving pile of five mangy brown sewer rats climbing over each other, beady red eyes, bared teeth",
    "skeleton_guard": "a skeleton soldier in rusted half-armour holding a round dented shield and a notched spear, "
    "hollow eye sockets with faint pale glow",
    "rotten_archer": "a rotting undead archer in a tattered grey hood, mossy greenish skin, drawing a crude bow",
    "slime": "a glossy translucent teal ooze blob with bones and old coins suspended inside it",
    "shade": "a wispy smoke-like shadow creature with long clawed hands and two glowing pale eyes, deep indigo and black",
    "cultist": "a robed cultist in dark crimson with the face hidden in a deep hood, holding a curved ritual dagger and "
    "a smoking brass censer",
    "rust_golem": "a hulking golem of rusted iron plates and rivets with a glowing furnace in its chest and huge fists",
    "rat_queen": "a giant rat matriarch standing upright, wearing a crown of bent cutlery and a tattered royal purple "
    "cape, holding a bone sceptre, bigger and more imposing than a person",
    "lamplighter": "a tall gaunt figure in a long dark coat and wide-brimmed hat, the face a dark void, carrying a long "
    "pole with a hook and a cluster of stolen lanterns burning with cold blue flames",
    # Биомы
    "wolf": "a lean grey forest wolf with bristling fur, bared fangs and yellow eyes, prowling low",
    "alpha_wolf": "a huge scarred black alpha wolf with a mane of thick fur, glowing amber eyes, an old arrow stuck in its shoulder, "
    "much larger than a normal wolf",
    "forest_spider": "a giant hairy forest spider with mottled green and brown legs and a cluster of shining eyes, fangs dripping venom",
    "bandit_archer": "a hooded forest bandit archer in patched brown leathers and a scarf over the face, drawing a short bow",
    "bandit_brute": "a burly bandit brute in a stained leather vest and iron bracers, holding a heavy wood axe, scarred bald head",
    "carrion_crow": "a monstrous carrion crow the size of a dog with ragged black feathers, a hooked beak and red eyes, wings spread",
    "rock_crawler": "a hulking crawling creature made of grey mountain rock and moss, stone plates for armour, glowing cracks",
    "mountain_witch": "an old mountain witch in grey furs and bone jewellery, holding a staff with a ram skull, faint green healing light in her hand",
    "leech_swarm": "a writhing knot of giant swamp leeches, glossy dark green and red bodies, round sucker mouths with tiny teeth",
    "bog_lurker": "a tall drowned swamp creature with long arms, skin like rotten bark covered in weed and mud, glowing pale eyes",
    "will_o_wisp": "a floating ghostly swamp wisp: a cold blue-green flame with a faint skull face inside, trailing sparks",
    "stone_sentinel": "a towering ancient stone guardian statue come alive, cracked granite body with runes glowing orange, "
    "a great stone halberd, much bigger than a person",
    "grave_knight": "an undead knight in blackened ornate plate armour with a torn cape, pale fire in the visor slits, "
    "holding a great sword, imposing and larger than a person",
}

PROP_STYLE = (
    "A single hand-painted fantasy tabletop terrain piece for a miniature wargame, rich painted finish with edge highlights, "
    "dark-fantasy mood. Full object visible, three-quarter view. No base, no ground, isolated on a fully transparent background. "
    "No text, no letters, no logos."
)
PROPS = {
    "forest_pine": "a tall dark pine tree",
    "forest_oak": "a gnarled old oak tree with twisted roots",
    "forest_bush": "a dense thorny bush with a few red berries",
    "mountains_boulder": "a large grey granite boulder with moss and lichen",
    "mountains_spire": "a jagged rock spire",
    "swamp_deadtree": "a dead swamp tree with drooping grey moss",
    "swamp_reeds": "a clump of tall swamp reeds and cattails",
    "ruins_pillar": "a broken ancient marble pillar overgrown with ivy",
    "ruins_wall": "a crumbling fragment of an old stone wall with an arch",
    "caves_stalagmite": "a cluster of wet glistening stalagmites",
    "caves_rocks": "a pile of dark cave rocks with glowing blue crystals",
}

GROUND_STYLE = (
    "Seamless tileable top-down texture for a fantasy tabletop game board, hand-painted look, even lighting, no shadows from objects, "
    "fills the whole square edge to edge, no border, no text."
)
GROUNDS = {
    "dungeon": "worn grey dungeon flagstones with dark mortar lines",
    "forest": "dark forest floor with grass, moss, fallen pine needles and small stones",
    "mountains": "rocky mountain ground with grey gravel, cracked stone and patches of snow",
    "swamp": "muddy swamp ground with dark wet earth, puddles and rotting leaves",
    "ruins": "broken ancient paving stones with grass growing between cracks",
    "caves": "dark cave floor with wet rock and scattered pebbles",
}

ITEM_STYLE = (
    "A single fantasy RPG inventory icon, hand-painted, rich colours, crisp edges, centred, dramatic lighting, "
    "isolated on a fully transparent background. No text, no letters, no frame."
)
ITEMS = {
    "potion": "a small round glass flask with glowing red healing liquid and a cork",
    "torch": "a burning wooden torch with an oily rag",
    "return_scroll": "a rolled parchment scroll with a glowing golden seal",
    "rusty_sword": "a rusty iron short sword with a leather grip",
    "hunter_bow": "a simple wooden hunting bow",
    "oak_staff": "a plain oak walking staff with a carved top",
    "war_axe": "a heavy steel battle axe with a bearded blade",
    "ash_longbow": "an elegant pale ash longbow with green fletched arrows",
    "runed_staff": "a dark staff with glowing violet runes along its length",
    "venom_dagger": "a curved dagger dripping green venom",
    "lamplighter_hook": "a long iron lamplighter hook with a small cold blue lantern hanging from it",
    "leather_jerkin": "a brown leather jerkin with buckles",
    "chain_shirt": "a steel chainmail shirt",
    "healer_robe": "a burgundy healer robe with embroidered herbs",
    "warden_plate": "a polished steel plate breastplate with an orange flame emblem",
    "brass_lantern": "a small brass lantern with a warm flame",
    "wolf_fang": "a large wolf fang on a leather cord",
    "crow_feather": "a black crow feather with a silver clasp",
    "owl_eye": "an amber gem shaped like an owl eye set in silver",
    "saint_medallion": "a round silver saint medallion on a chain",
    "bone_charm": "a charm of small carved bones tied with red thread",
    "lucky_die": "a worn ivory six-sided die with gold pips",
    "abyss_shard": "a jagged shard of black crystal glowing with violet light",
    "fate_coin": "an ancient gold coin with a lantern on one side",
}


entries = (
    [{"key": k, "kind": "mini", "path": f"apps/web/public/art/minis/{k}.png", "prompt": f"{STYLE} Subject: {d}."} for k, d in MINIS.items()]
    + [{"key": k, "kind": "prop", "path": f"apps/web/public/art/props/{k}.png", "prompt": f"{PROP_STYLE} Subject: {d}."} for k, d in PROPS.items()]
    + [{"key": f"ground_{k}", "kind": "ground", "path": f"apps/web/public/art/ground/{k}.jpg", "prompt": f"{GROUND_STYLE} Surface: {d}."} for k, d in GROUNDS.items()]
    + [{"key": f"item_{k}", "kind": "item", "path": f"apps/web/public/art/items/{k}.png", "prompt": f"{ITEM_STYLE} Subject: {d}."} for k, d in ITEMS.items()]
)
(ROOT / "tools/art-manifest.json").write_text(json.dumps(entries, ensure_ascii=False, indent=1) + "\n")
print(f"{len(entries)} entries")
