#!/usr/bin/env python3
"""
Editor de mod do Yu-Gi-Oh! Forbidden Memories (imagem .bin, 2352 bytes/setor).

Grava alterações direto nos setores da imagem e recalcula EDC/ECC de cada setor
tocado, para o .bin continuar válido. Nunca altera o arquivo de entrada.

Uso:
  python3 tools/fmmod.py check  jogo.bin
  python3 tools/fmmod.py show   jogo.bin "Megamorph"
  python3 tools/fmmod.py build  jogo.bin saida.bin receita.json

Receita (JSON):
  {
    "drops": [
      {"card": "Megamorph", "duelist": "Pegasus", "pool": "pow", "rate": 64},
      {"card": 657, "duelist": "all", "pool": "pow", "copy_from": "tec"}
    ]
  }
  pool: pow (S/A POW), bcd (B/C/D), tec (S/A TEC) ou deck.
  rate: em 2048 avos. A soma da tabela continua 2048: o que é adicionado sai
  proporcionalmente das outras cartas da mesma tabela.
  copy_from: usa a chance que a carta já tem no outro pool daquele duelista.
    "hard_decks": 2.0
  Reescala o deck de cada duelista para favorecer os monstros mais fortes que ele
  já usa (peso x (ATK/1000)^n). Não coloca cartas novas no deck.

    "free_duel_all": true
  Libera todos os duelistas no Free Duel desde o início (WA_MRG.MRG 0xF6D3DC: o
  "sb zero" que tranca quem não tem a flag 0x6E0+id vira nop).
    "multi_drop": 100
  Cartas por duelo vencido (só no executável original SLUS_014.11). Usa uma rotina
  de 27 instruções, gravada num trecho de código que o jogo não chama (0x80060E70):
  entrega a carta normal e sorteia mais N-1 na mesma tabela de drop do rank.

Também gera um patch .ppf com as diferenças (python3 tools/fmmod.py ppf original.bin mod.bin saida.ppf).
"""
import json
import struct
import sys

SECTOR = 2352
CARDS = 722
DUELISTS = 39
MRG_DUELISTS = 0xE9B000
DUELIST_STRIDE = 0x1800
POOLS = {"deck": 0x0, "pow": 0x5B4, "bcd": 0xB68, "tec": 0x111C}

# ---------------------------------------------------------------- EDC / ECC
EDC_LUT = []
for i in range(256):
    e = i
    for _ in range(8):
        e = (e >> 1) ^ (0xD8018001 if e & 1 else 0)
    EDC_LUT.append(e)
ECC_F = [((i << 1) ^ (0x11D if i & 0x80 else 0)) & 0xFF for i in range(256)]
ECC_B = [0] * 256
for i in range(256):
    ECC_B[i ^ ECC_F[i]] = i


def edc(data):
    e = 0
    for b in data:
        e = (e >> 8) ^ EDC_LUT[(e ^ b) & 0xFF]
    return e


def ecc_block(src, major_count, minor_count, major_mult, minor_inc):
    size = major_count * minor_count
    out = bytearray(major_count * 2)
    for major in range(major_count):
        index = (major >> 1) * major_mult + (major & 1)
        a = b = 0
        for _ in range(minor_count):
            t = src[index]
            index += minor_inc
            if index >= size:
                index -= size
            a ^= t
            b ^= t
            a = ECC_F[a]
        a = ECC_B[ECC_F[a] ^ b]
        out[major] = a
        out[major + major_count] = a ^ b
    return out


def fix_sector(sec):
    """Recalcula EDC/ECC de um setor Mode 2 Form 1 (sec: bytearray de 2352)."""
    if sec[15] != 2 or sec[18] & 0x20:  # só Mode 2 Form 1
        return
    struct.pack_into("<I", sec, 0x818, edc(sec[0x10:0x818]))
    src = bytearray(4) + sec[0x10:0x8C8]  # endereço zerado no Mode 2
    p = ecc_block(src, 86, 24, 2, 86)
    sec[0x81C:0x81C + 172] = p
    src = bytearray(4) + sec[0x10:0x81C] + p
    sec[0x8C8:0x8C8 + 104] = ecc_block(src, 52, 43, 86, 88)


# ---------------------------------------------------------------- imagem
class Image:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = bytearray(f.read())
        if self.data[:12] != b"\x00" + b"\xff" * 10 + b"\x00":
            sys.exit("Esperava uma imagem .bin crua (2352 bytes por setor).")
        self.dirty = set()
        self.files = {}
        pvd = self.sectors(16, 1)
        if pvd[1:6] != b"CD001":
            sys.exit("Imagem sem sistema de arquivos ISO9660.")
        root = pvd[156:190]
        self._walk(struct.unpack_from("<I", root, 2)[0], struct.unpack_from("<I", root, 10)[0], "", 0)
        cnf = self.files.get("SYSTEM.CNF")
        exe = None
        if cnf:
            txt = self.read(cnf, 0, min(cnf[1], 2048)).decode("latin1")
            for line in txt.splitlines():
                if line.upper().startswith("BOOT"):
                    exe = line.split("\\")[-1].split(";")[0].strip().upper()
        self.slus = self.files.get(exe) or next(v for k, v in self.files.items() if k.startswith("SLUS_"))
        self.mrg = self.files["WA_MRG.MRG"]
        self.exe_name = exe

    def sectors(self, lba, n):
        out = bytearray()
        for i in range(n):
            o = (lba + i) * SECTOR + 24
            out += self.data[o:o + 2048]
        return out

    def _walk(self, lba, size, path, depth):
        d = self.sectors(lba, (size + 2047) // 2048)
        p = 0
        while p < size:
            ln = d[p]
            if ln == 0:
                p = (p // 2048 + 1) * 2048
                continue
            ext, sz, flags, nl = struct.unpack_from("<I", d, p + 2)[0], struct.unpack_from("<I", d, p + 10)[0], d[p + 25], d[p + 32]
            name = d[p + 33:p + 33 + nl].decode("latin1").split(";")[0].upper()
            if flags & 2:
                if nl > 1 and depth < 4 and ext != lba:
                    self._walk(ext, sz, path + name + "/", depth + 1)
            else:
                self.files[name] = (ext, sz)
            p += ln

    def read(self, f, off, n):
        out = bytearray()
        while n > 0:
            lba, o = f[0] + off // 2048, off % 2048
            k = min(n, 2048 - o)
            s = lba * SECTOR + 24 + o
            out += self.data[s:s + k]
            off, n = off + k, n - k
        return out

    def write(self, f, off, buf):
        i = 0
        while i < len(buf):
            lba, o = f[0] + (off + i) // 2048, (off + i) % 2048
            k = min(len(buf) - i, 2048 - o)
            s = lba * SECTOR + 24 + o
            if self.data[s:s + k] != buf[i:i + k]:
                self.data[s:s + k] = buf[i:i + k]
                self.dirty.add(lba)
            i += k

    def save(self, path):
        for lba in sorted(self.dirty):
            o = lba * SECTOR
            sec = bytearray(self.data[o:o + SECTOR])
            fix_sector(sec)
            self.data[o:o + SECTOR] = sec
        with open(path, "wb") as f:
            f.write(self.data)
        return len(self.dirty)


# ---------------------------------------------------------------- código
CALL_SITE = 0x80021F14          # jal Duel_AwardCard depois do duelo
AWARD_CARD = 0x80021894
ROUTINE = 0x80060E70            # função sem nenhuma chamada no executável original
ROUTINE_RETAIL_HEAD = bytes.fromhex("c0ffbd272400b3af219880003400b7af")
# addiu sp,-0x18; sw ra; sw s0; jal Award(a0); li s0,N-1
# loop: pool = rank (S/A TEC=2 se venceu por técnica, B/C/D=1 se rank baixo, senão S/A POW=0)
#       carta = Duel_SelectCardDrop(pool); if carta: Duel_AwardCard(carta); s0--; bnez loop
ROUTINE_CODE = ("e8ffbd271400bfaf1000b0af2586000c{count}1024e002838f0000000039006290380063902b1002000300632c"
                "0200601040200200010004240486000c0000000003004010000000002586000c25204000ffff1026efff0016"
                "000000001400bf8f1000b08f0800e0031800bd27")


def jal(addr):
    return struct.pack("<I", 0x0C000000 | ((addr >> 2) & 0x3FFFFFF))


def patch_multi_drop(img, count):
    if not 2 <= count <= 999:
        sys.exit("multi_drop precisa ser de 2 a 999")
    head = img.read(img.slus, 0, 0x800)
    t_addr = struct.unpack_from("<I", head, 0x18)[0]
    off = lambda ram: ram - t_addr + 0x800
    if img.read(img.slus, off(CALL_SITE), 4) != jal(AWARD_CARD) or \
            img.read(img.slus, off(ROUTINE), 16) != ROUTINE_RETAIL_HEAD:
        sys.exit("multi_drop: o executável não é o original (SLUS_014.11 sem modificação).")
    code = bytes.fromhex(ROUTINE_CODE.format(count=struct.pack("<H", count - 1).hex()))
    img.write(img.slus, off(ROUTINE), code)
    img.write(img.slus, off(CALL_SITE), jal(ROUTINE))
    print(f"{count} cartas por duelo vencido")


# ---------------------------------------------------------------- dados do jogo
CHARS = {0x18: 'A', 0x2D: 'B', 0x2B: 'C', 0x20: 'D', 0x25: 'E', 0x31: 'F', 0x29: 'G', 0x23: 'H', 0x1A: 'I',
         0x3B: 'J', 0x33: 'K', 0x2A: 'L', 0x1E: 'M', 0x2C: 'N', 0x21: 'O', 0x2F: 'P', 0x3E: 'Q', 0x26: 'R',
         0x1D: 'S', 0x1C: 'T', 0x35: 'U', 0x39: 'V', 0x22: 'W', 0x46: 'X', 0x24: 'Y', 0x3F: 'Z', 0x03: 'a',
         0x15: 'b', 0x0F: 'c', 0x0C: 'd', 0x01: 'e', 0x13: 'f', 0x10: 'g', 0x09: 'h', 0x05: 'i', 0x34: 'j',
         0x16: 'k', 0x0A: 'l', 0x0E: 'm', 0x06: 'n', 0x04: 'o', 0x14: 'p', 0x37: 'q', 0x08: 'r', 0x07: 's',
         0x02: 't', 0x0D: 'u', 0x19: 'v', 0x12: 'w', 0x36: 'x', 0x11: 'y', 0x32: 'z', 0x38: '0', 0x3D: '1',
         0x3A: '2', 0x41: '3', 0x4A: '4', 0x42: '5', 0x4E: '6', 0x45: '7', 0x57: '8', 0x59: '9', 0x00: ' ',
         0x30: '-', 0x3C: '#', 0x43: '&', 0x0B: '.', 0x1F: ',', 0x17: '!', 0x1B: "'", 0x48: ':', 0x4B: ')',
         0x4C: '(', 0x44: '/', 0x2E: '?', 0x40: '"', 0x56: '+'}


def text(buf, pos):
    s = ""
    while pos < len(buf) and buf[pos] != 0xFF and len(s) < 64:
        s += CHARS.get(buf[pos], "")
        pos += 1
    return s.strip()


class Game:
    def __init__(self, img):
        self.img = img
        slus = img.read(img.slus, 0, img.slus[1])
        base = 0x1C6800 - 0x6000
        self.cards = [text(slus, base + struct.unpack_from("<H", slus, 0x1C6002 + i * 2)[0]) for i in range(CARDS)]
        self.duelists = [text(slus, base + struct.unpack_from("<H", slus, 0x1C6652 + i * 2)[0]) for i in range(DUELISTS)]

    def card_id(self, c):
        if isinstance(c, int):
            return c
        hits = [i + 1 for i, n in enumerate(self.cards) if n.lower() == c.lower()] or \
               [i + 1 for i, n in enumerate(self.cards) if c.lower() in n.lower()]
        if len(hits) != 1:
            sys.exit(f"Carta '{c}': {len(hits)} resultados " + str([self.cards[h - 1] for h in hits[:8]]))
        return hits[0]

    def duelist_ids(self, d):
        if d == "all":
            return list(range(1, DUELISTS + 1))
        if isinstance(d, int):
            return [d]
        hits = [i + 1 for i, n in enumerate(self.duelists) if n.lower().startswith(d.lower())]
        exact = [h for h in hits if self.duelists[h - 1].lower() == d.lower()]
        hits = exact or hits
        if len(hits) != 1:
            sys.exit(f"Duelista '{d}': {len(hits)} resultados " + str([self.duelists[h - 1] for h in hits]))
        return hits

    def table(self, duelist, pool):
        off = MRG_DUELISTS + (duelist - 1) * DUELIST_STRIDE + POOLS[pool]
        return list(struct.unpack("<722H", self.img.read(self.img.mrg, off, CARDS * 2)))

    def set_table(self, duelist, pool, t):
        if pool != "deck" and sum(t) != 2048:
            raise ValueError(f"tabela {self.duelists[duelist - 1]}/{pool} somaria {sum(t)}")
        off = MRG_DUELISTS + (duelist - 1) * DUELIST_STRIDE + POOLS[pool]
        self.img.write(self.img.mrg, off, struct.pack("<722H", *t))

    def set_rate(self, duelist, pool, card, rate):
        """Define a chance de uma carta; o resto da tabela é reescalado para somar 2048."""
        t = self.table(duelist, pool)
        total = 2048 if pool != "deck" else sum(t)
        others = total - t[card - 1]
        target = total - rate
        if rate < 0 or rate > total or (others == 0 and target > 0):
            raise ValueError("chance inválida")
        new = [0] * CARDS
        new[card - 1] = rate
        # Distribui o restante proporcionalmente (maior resto primeiro), sem zerar quem já tinha chance.
        idx = [i for i in range(CARDS) if i != card - 1 and t[i]]
        exact = {i: t[i] * target / others for i in idx}
        for i in idx:
            new[i] = max(1, int(exact[i])) if target >= len(idx) else int(exact[i])
        diff = target - sum(new[i] for i in idx)
        order = sorted(idx, key=lambda i: exact[i] - int(exact[i]), reverse=diff > 0)
        k = 0
        while diff != 0 and order:
            i = order[k % len(order)]
            step = 1 if diff > 0 else -1
            if new[i] + step >= (1 if target >= len(idx) else 0):
                new[i] += step
                diff -= step
            k += 1
        self.set_table(duelist, pool, new)


POOL_NAMES = {"pow": "S/A POW", "bcd": "B/C/D", "tec": "S/A TEC", "deck": "Deck"}


def cmd_show(img, query):
    g = Game(img)
    cid = g.card_id(int(query) if query.isdigit() else query)
    print(f"#{cid} {g.cards[cid - 1]}")
    for d in range(1, DUELISTS + 1):
        for p in POOLS:
            r = g.table(d, p)[cid - 1]
            if r:
                print(f"  {g.duelists[d - 1]:<24} {POOL_NAMES[p]:<8} {r:>5}/2048" if p != "deck" else
                      f"  {g.duelists[d - 1]:<24} {POOL_NAMES[p]:<8} peso {r}")


def cmd_build(img, out, recipe_path):
    g = Game(img)
    recipe = json.load(open(recipe_path, encoding="utf-8"))
    if recipe.get("free_duel_all"):
        cur = img.read(img.mrg, 0xF6D3DC, 4)
        if cur == bytes.fromhex("000040a0"):
            img.write(img.mrg, 0xF6D3DC, bytes(4))
            print("todos os duelistas liberados no Free Duel")
        elif cur != bytes(4):
            sys.exit("free_duel_all: código do menu do Free Duel diferente do esperado.")
    if recipe.get("multi_drop"):
        patch_multi_drop(img, int(recipe["multi_drop"]))
    for step in recipe.get("add_drops", []):
        cid = g.card_id(step["card"])
        for dn in step["duelists"]:
            for d in g.duelist_ids(dn):
                for pool in step["pools"]:
                    if g.table(d, pool)[cid - 1] < step["rate"]:
                        g.set_rate(d, pool, cid, step["rate"])
        print(f"{g.cards[cid - 1]}: {', '.join(step['duelists'])} ({'/'.join(POOL_NAMES[p] for p in step['pools'])}) {step['rate']}/2048")
    for step in recipe.get("drops", []):
        cid = g.card_id(step["card"])
        for d in g.duelist_ids(step["duelist"]):
            pool = step["pool"]
            rate = g.table(d, step["copy_from"])[cid - 1] if "copy_from" in step else step["rate"]
            if "copy_from" in step and not rate:
                continue
            before = g.table(d, pool)[cid - 1]
            g.set_rate(d, pool, cid, rate)
            print(f"{g.cards[cid - 1]} · {g.duelists[d - 1]} · {POOL_NAMES[pool]}: {before} -> {rate} /2048")
    if recipe.get("hard_decks"):
        slus = img.read(img.slus, 0, img.slus[1])
        atk = [(struct.unpack_from("<I", slus, 0x1C4A44 + i * 4)[0] & 0x1FF) * 10 for i in range(CARDS)]
        monster = [((struct.unpack_from("<I", slus, 0x1C4A44 + i * 4)[0] >> 26) & 0x1F) < 20 for i in range(CARDS)]
        n_pow = float(recipe["hard_decks"])
        for d in range(1, DUELISTS + 1):
            t = g.table(d, "deck")
            w = [t[i] * ((max(atk[i], 100) / 1000.0) ** n_pow if monster[i] else 1.0) for i in range(CARDS)]
            tot = sum(w)
            new = [int(w[i] * 2048 / tot) if t[i] else 0 for i in range(CARDS)]
            for i in range(CARDS):
                if t[i] and new[i] == 0:
                    new[i] = 1
            # ajuste fino para fechar 2048 exatos
            order = sorted([i for i in range(CARDS) if t[i]], key=lambda i: -w[i])
            k = 0
            while sum(new) != 2048:
                i = order[k % len(order)]
                if sum(new) < 2048:
                    new[i] += 1
                elif new[i] > 1:
                    new[i] -= 1
                k += 1
            g.set_table(d, "deck", new)
        print(f"decks reescalados (dificuldade, expoente {n_pow}) para {DUELISTS} duelistas")
    n = img.save(out)
    print(f"{n} setores alterados -> {out}")


def cmd_check(img):
    """Confere se o EDC/ECC recalculado bate com o original em setores intactos."""
    ok = bad = 0
    total = len(img.data) // SECTOR
    for lba in list(range(16, 40)) + list(range(img.mrg[0], img.mrg[0] + 200, 7)) + [total - 1]:
        o = lba * SECTOR
        sec = bytearray(img.data[o:o + SECTOR])
        if sec[15] != 2 or sec[18] & 0x20:
            continue
        orig = bytes(sec)
        fix_sector(sec)
        ok += bytes(sec) == orig
        bad += bytes(sec) != orig
    g = Game(img)
    print(f"executável {img.exe_name}, WA_MRG.MRG em LBA {img.mrg[0]}")
    print(f"EDC/ECC: {ok} setores conferem, {bad} diferentes")
    print("cartas:", g.cards[0], "...", g.cards[CARDS - 1], "| duelistas:", ", ".join(g.duelists[:4]), "...")


def cmd_ppf(orig_path, mod_path, out, desc):
    a = open(orig_path, "rb").read()
    b = open(mod_path, "rb").read()
    if len(a) != len(b):
        sys.exit("As imagens precisam ter o mesmo tamanho.")
    # PPF3 com undo: cada registro leva também os bytes originais, assim quem aplica confere a versão.
    head = b"PPF30" + bytes([2]) + desc.encode("ascii", "replace")[:50].ljust(50, b" ") + bytes([0, 0, 1, 0])
    recs = bytearray()
    i, n = 0, len(a)
    while i < n:
        if a[i] == b[i]:
            # pula rápido blocos iguais
            j = i + 4096
            if j <= n and a[i:j] == b[i:j]:
                i = j
                continue
            i += 1
            continue
        j = i
        while j < n and j - i < 255 and a[j] != b[j]:
            j += 1
        recs += struct.pack("<QB", i, j - i) + b[i:j] + a[i:j]
        i = j
    open(out, "wb").write(head + recs)
    print(f"patch {out}: {len(head) + len(recs)} bytes")


if __name__ == "__main__":
    if len(sys.argv) >= 5 and sys.argv[1] == "ppf":
        cmd_ppf(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else "FM Drops mod")
        sys.exit()
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    image = Image(sys.argv[2])
    if sys.argv[1] == "check":
        cmd_check(image)
    elif sys.argv[1] == "show":
        cmd_show(image, sys.argv[3])
    elif sys.argv[1] == "build":
        cmd_build(image, sys.argv[3], sys.argv[4])
    else:
        sys.exit(__doc__)
