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
}

entries = [
    {"key": k, "kind": "mini", "path": f"apps/web/public/art/minis/{k}.png", "prompt": f"{STYLE} Subject: {d}."}
    for k, d in MINIS.items()
]
(ROOT / "tools/art-manifest.json").write_text(json.dumps(entries, ensure_ascii=False, indent=1) + "\n")
print(f"{len(entries)} entries")
