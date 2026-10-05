"""Trilha do demo reel: música sintetizada + narração neural pt-BR (edge-tts).

Gera em <dir>: musica.wav, narracao/NN.mp3, narracao.wav (alinhada no tempo)
e mix.wav (música com ducking sob a voz). Depois:
  ffmpeg -framerate 24 -i frames/f%05d.jpg -i mix.wav ... saida.mp4

Uso: py -3 scripts/reel/audio.py <dir> [--voz pt-BR-FranciscaNeural]
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 48000
DUR = 180.0
LANG = sys.argv[sys.argv.index('--lang') + 1] if '--lang' in sys.argv else 'pt'
VOZ = sys.argv[sys.argv.index('--voz') + 1] if '--voz' in sys.argv else ('en-US-AndrewNeural' if LANG == 'en' else 'pt-BR-FranciscaNeural')
SUF = '' if LANG == 'pt' else f'-{LANG}'
DIR = Path(sys.argv[1]).resolve()

# (início em s, fim máximo em s, texto). Fatos de DATA_SOURCES.md, index.html e das camadas.
ROTEIRO = [
    (2.4, 9.0, 'DataGeo Paraná: os 399 municípios numa sala de situação.'),
    (9.6, 20.0, 'Dados públicos, pipelines próprios, tudo ao vivo. O mapa roda em MapLibre, globo ou 2D, com satélite, OpenStreetMap e relevo, sem chave de API.'),
    (20.6, 37.0, 'Tudo o que aparece no mapa sai do painel de camadas: 58 camadas DataGeo e 16 de contexto global, em 13 grupos temáticos. Cada linha mostra a fonte, a contagem e a última atualização.'),
    (37.6, 53.0, 'Na visão do estado, a rede pública no território: as 23 regionais e as 447 unidades do IDR-Paraná, os 148 escritórios da ADAPAR, com circunscrição e contato, e as cinco CEASAs.'),
    (53.6, 68.0, 'Logística e energia: rodovias, ferrovias, armazéns da CONAB, CEASAs e os navios no Porto de Paranaguá. E a rede da Copel, com 777 mil trechos, transmissão, subestações e usinas.'),
    (68.6, 84.0, 'O que muda sozinho, muda no mapa: estações do INMET, nível dos rios, alertas do CEMADEN, focos de calor, incidentes, dengue, qualidade do ar e o line-up do porto. Pipelines próprios atualizam tudo sem intervenção.'),
    (84.6, 100.0, 'Na localização, basta digitar o município: a busca é local, pelos 399, e devolve o código do IBGE. Enter enquadra e abre a ficha; a tecla P volta ao Paraná inteiro.'),
    (100.6, 118.0, 'A ficha municipal cruza todas as bases: território, extensionistas, GETEC, SUSAF, módulo fiscal, economia, agricultura familiar, estrutura fundiária, população, proteção social, segurança, ambiente, clima, outorgas, fontes e hidrologia.'),
    (118.6, 134.0, 'De perto, o território aparece: 533 mil imóveis do CAR, 394 mil trechos de estradas municipais, as conveniadas com a SEAB, 227 faxinais, 81 unidades de conservação e as outorgas de água.'),
    (134.6, 150.0, 'Na agricultura familiar, um ponto por família do CAF e 401 cooperativas ligadas às sócias. Na defesa agropecuária, 284 mil propriedades com pecuária e os estabelecimentos da ADAPAR. Dado pessoal só para usuário autorizado.'),
    (150.6, 166.0, 'A vigilância varre, a cada cinco minutos, focos, alertas e incidentes em até dez municípios, com exportação em CSV. O link compartilhado leva câmera, estilo e camadas: quem abre vê a mesma tela.'),
    (166.6, 180.0, 'Sete estilos visuais, do normal ao térmico. DataGeo Paraná: dados públicos, pipelines próprios, tudo ao vivo.'),
]


ROTEIRO_EN = [
    (2.4, 9.0, 'DataGeo Paraná: 399 municipalities in one situation room.'),
    (9.6, 20.0, 'Public data, in-house pipelines, all live. The map runs on MapLibre, as a globe or in 2D, with satellite, OpenStreetMap and terrain. No API key needed.'),
    (20.6, 37.0, 'Everything on the map comes from the data layers panel: 58 DataGeo layers plus 16 global-context layers, in 13 thematic groups. Each row shows the source, the count and the last update.'),
    (37.6, 53.0, 'In the state view, the public network across the territory: the 23 regional offices and 447 units of IDR-Paraná, the 148 ADAPAR offices, with jurisdiction and contact, and the five CEASA food supply centers.'),
    (53.6, 68.0, 'Logistics and energy: highways, railways, CONAB warehouses, CEASAs and ships at the Port of Paranaguá. Plus the Copel grid, 777 thousand segments, with transmission, substations and plants.'),
    (68.6, 84.0, 'What changes on its own, changes on the map: INMET weather stations, river levels, CEMADEN disaster alerts, fire hotspots, incidents, dengue, air quality and the port line-up. In-house pipelines keep it all fresh, no manual work.'),
    (84.6, 100.0, 'In location search, just type the municipality. The search is local, across all 399, and returns the IBGE code. Enter frames it and opens the profile; the P key takes the camera back to the whole state.'),
    (100.6, 118.0, 'The municipal profile joins every database: territory, extension agents, GETEC, SUSAF, fiscal module, economy, family farming, land, population, social protection, safety, environment, climate, water permits, springs and hydrology.'),
    (118.6, 134.0, 'Up close, the territory shows: 533 thousand active CAR properties, 394 thousand municipal road segments, the SEAB road agreements, 227 faxinais, 81 conservation units and live water permits.'),
    (134.6, 150.0, 'In family farming, one point per CAF family and 401 cooperatives linked to their members. In agricultural defense, 284 thousand livestock properties and the establishments registered with ADAPAR. Personal data only for authorized users.'),
    (150.6, 166.0, 'Monitoring sweeps every five minutes for fire hotspots, alerts and incidents across up to ten municipalities, with CSV export. And the share link carries camera, style and layers: whoever opens it sees the same screen.'),
    (166.6, 180.0, 'Seven visual styles, from normal to thermal. DataGeo Paraná: public data, in-house pipelines, all live.'),
]
if LANG == 'en':
    ROTEIRO = ROTEIRO_EN


def srt(partes: list[dict]) -> None:
    """Legendas: cada fala vira cues de até ~84 caracteres (2 linhas), com o tempo dividido pelo tamanho do texto."""
    import re
    def ts(t: float) -> str:
        ms = int(round(t * 1000)); h, r = divmod(ms, 3600000); m, r = divmod(r, 60000); sec, ms = divmod(r, 1000)
        return f'{h:02d}:{m:02d}:{sec:02d},{ms:03d}'
    def duas_linhas(txt: str) -> str:
        if len(txt) <= 64:
            return txt
        pal = txt.split(); a = []
        while pal and len(' '.join(a + [pal[0]])) <= max(50, len(txt) // 2 + 6):
            a.append(pal.pop(0))
        return ' '.join(a) + chr(10) + ' '.join(pal)
    cues = []
    for p in partes:
        frases = [f.strip() for f in re.split(r'(?<=[.;:])\s+', p['texto']) if f.strip()]
        pedacos = []
        for f in frases:
            if len(f) <= 84:
                pedacos.append(f); continue
            pal = f.split(); cur = []
            for w in pal:
                if len(' '.join(cur + [w])) > 84:
                    pedacos.append(' '.join(cur)); cur = [w]
                else:
                    cur.append(w)
            if cur:
                pedacos.append(' '.join(cur))
        total = sum(len(x) for x in pedacos)
        t = p['inicio']
        for x in pedacos:
            d = p['dur'] * len(x) / total
            cues.append((t, min(t + d, p['inicio'] + p['dur']) - 0.05, duas_linhas(x)))
            t += d
    out = []
    for i, (a, b, txt) in enumerate(cues, 1):
        out.append(f'{i}' + chr(10) + f'{ts(a)} --> {ts(b)}' + chr(10) + txt + chr(10))
    (DIR / f'legendas{SUF}.srt').write_text(chr(10).join(out), encoding='utf-8')
    print(f'legendas{SUF}.srt: {len(cues)} cues')


# ------------------------------------------------------------------ música
def nota(semitons: float) -> float:
    return 110.0 * 2 ** (semitons / 12)  # A2 = 110 Hz


def env(n: int, a: float, d: float, s: float, r: float, dur: float) -> np.ndarray:
    t = np.arange(n) / SR
    e = np.ones(n) * s
    e[t < a] = t[t < a] / a
    m = (t >= a) & (t < a + d)
    e[m] = 1 - (1 - s) * (t[m] - a) / d
    rel = t > dur - r
    e[rel] *= np.clip((dur - t[rel]) / r, 0, 1)
    return e


def saw(f: float, n: int, detune: float = 0.0) -> np.ndarray:
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, 12):  # série limitada: evita aliasing e soa mais "pad"
        out += np.sin(2 * np.pi * f * (1 + detune) * k * t) / k
    return out


def lowpass(x: np.ndarray, hz: float) -> np.ndarray:
    # 1 polo, duas passagens: suave, suficiente para um pad.
    a = np.exp(-2 * np.pi * hz / SR)
    y = np.zeros_like(x)
    acc = 0.0
    for i in range(len(x)):  # noqa: PERF — 8,6 M amostras, ~10 s; aceitável
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def musica() -> np.ndarray:
    """Lá menor, 92 bpm: pad em acordes (Am, F, C, G), sub pulsado, arpejo de 'pluck' e hi-hat de ruído."""
    bpm = 92
    beat = 60 / bpm
    bar = 4 * beat
    n_total = int(DUR * SR)
    out = np.zeros((n_total, 2))
    acordes = [[0, 3, 7, 12], [-4, 0, 3, 8], [-9, -2, 3, 7], [-2, 2, 5, 10]]  # Am F C G (semitons de A2)
    t_bar = 0.0
    i_bar = 0
    rng = np.random.default_rng(7)
    while t_bar < DUR:
        ac = acordes[i_bar % 4]
        n = int(bar * SR)
        s0 = int(t_bar * SR)
        seg = slice(s0, min(s0 + n, n_total))
        m = out[seg].shape[0]
        # pad
        pad = np.zeros(m)
        for st in ac:
            f = nota(st + 12)
            pad += saw(f, m, 0.0015) + saw(f, m, -0.0015)
        pad *= env(m, 0.9, 0.5, 0.75, 1.2, bar) * 0.035
        # sub: fundamental, pulsando em colcheias
        sub = np.sin(2 * np.pi * nota(ac[0]) * np.arange(m) / SR)
        pulso = (np.sin(2 * np.pi * (2 / beat) * np.arange(m) / SR) > -0.2).astype(float)
        sub *= pulso * env(m, 0.01, 0.3, 0.6, 0.3, bar) * 0.11
        # arpejo pluck em semicolcheias, alternando notas do acorde (só a partir do 3º compasso)
        arp = np.zeros(m)
        if i_bar >= 2:
            step = int(beat / 2 * SR)
            for k in range(0, m, step):
                st = ac[(k // step) % 4] + 24
                ln = min(int(0.35 * SR), m - k)
                tt = np.arange(ln) / SR
                tone = np.sin(2 * np.pi * nota(st) * tt) * np.exp(-tt * 9) + 0.3 * np.sin(2 * np.pi * nota(st) * 2 * tt) * np.exp(-tt * 14)
                arp[k:k + ln] += tone * (0.045 if (k // step) % 4 else 0.06)
        # hi-hat: ruído curto nas contratempos (fraco), de 4º compasso em diante
        hat = np.zeros(m)
        if i_bar >= 4:
            step = int(beat * SR)
            for k in range(step // 2, m, step):
                ln = min(int(0.05 * SR), m - k)
                hat[k:k + ln] += rng.normal(0, 1, ln) * np.exp(-np.arange(ln) / SR * 90) * 0.02
        mono = pad + sub + arp + hat
        out[seg, 0] += mono + 0.12 * np.roll(arp, int(0.011 * SR))
        out[seg, 1] += mono + 0.12 * np.roll(arp, -int(0.013 * SR))
        t_bar += bar
        i_bar += 1
    # filtro suave no conjunto e curva de volume: entra, sustenta, abaixa no fim
    out[:, 0] = lowpass(out[:, 0], 5200)
    out[:, 1] = lowpass(out[:, 1], 5200)
    t = np.arange(n_total) / SR
    curva = np.clip(t / 4, 0, 1) * np.clip((DUR - t) / 6, 0, 1)
    out *= curva[:, None]
    out /= max(1e-9, np.abs(out).max()) / 0.7
    return out


def wav(path: Path, data: np.ndarray) -> None:
    import wave
    pcm = (np.clip(data, -1, 1) * 32767).astype('<i2')
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(data.shape[1] if data.ndim == 2 else 1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------- narração
async def falar(texto: str, mp3: Path, rate: str) -> None:
    import edge_tts
    await edge_tts.Communicate(texto, VOZ, rate=rate).save(str(mp3))


def duracao(arq: Path) -> float:
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(arq)],
                       capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def narracao() -> list[dict]:
    pasta = DIR / f'narracao{SUF}'
    pasta.mkdir(exist_ok=True)
    partes = []
    for i, (ini, fim, texto) in enumerate(ROTEIRO):
        janela = fim - ini - 0.8
        rate = '+0%'
        for tentativa in range(4):
            mp3 = pasta / f'{i:02d}.mp3'
            asyncio.run(falar(texto, mp3, rate))
            d = duracao(mp3)
            if d <= janela:
                break
            # acelera o quanto falta, com folga
            pct = int(min(12, (d / janela - 1) * 100 + 3 + tentativa * 2))
            rate = f'+{pct}%'
        partes.append({'i': i, 'inicio': ini, 'dur': d, 'rate': rate, 'cabe': d <= janela, 'texto': texto})
        print(f'  {i:02d} {ini:6.1f}s  {d:5.1f}s / janela {janela:4.1f}s  rate {rate}  {"ok" if d <= janela else "ESTOURA"}')
    (DIR / f'narracao{SUF}.json').write_text(json.dumps(partes, ensure_ascii=False, indent=1), encoding='utf-8')
    # alinha as partes na linha do tempo num único WAV
    inputs = []
    filtros = []
    for p in partes:
        inputs += ['-i', str(pasta / f'{p["i"]:02d}.mp3')]
        filtros.append(f'[{p["i"]}:a]aresample={SR},aformat=channel_layouts=mono,adelay={int(p["inicio"] * 1000)}|{int(p["inicio"] * 1000)}[v{p["i"]}]')
    filtros.append(''.join(f'[v{p["i"]}]' for p in partes) + f'amix=inputs={len(partes)}:normalize=0,apad=whole_dur={DUR},atrim=0:{DUR},'
                   'highpass=f=90,acompressor=threshold=-18dB:ratio=2.5:attack=8:release=120,volume=1.6,alimiter=limit=0.9[voz]')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', ';'.join(filtros), '-map', '[voz]',
                    str(DIR / f'narracao{SUF}.wav')], check=True)
    srt(partes)
    return partes


def mix() -> None:
    # música -14 dB sob a voz (sidechain), -6 dB sem voz; o ambiente antigo entra bem baixo.
    fc = (
        f'[1:a]volume=0.45[m];'
        f'[0:a]aformat=channel_layouts=stereo,asplit=2[v][sc];'
        f'[m][sc]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=600:makeup=1[md];'
        f'[v][md]amix=inputs=2:normalize=0,alimiter=limit=0.95[out]'
    )
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(DIR / f'narracao{SUF}.wav'), '-i', str(DIR / 'musica.wav'),
                    '-filter_complex', fc, '-map', '[out]', '-ar', str(SR), str(DIR / f'mix{SUF}.wav')], check=True)


if __name__ == '__main__':
    if not (DIR / 'musica.wav').exists() or '--musica' in sys.argv:
        print('música…')
        wav(DIR / 'musica.wav', musica())
    print('narração…', VOZ)
    partes = narracao()
    print('mix…')
    mix()
    print('pronto:', DIR / f'mix{SUF}.wav', '| estouram:', [p['i'] for p in partes if not p['cabe']])
