# Flusso Flotte — Modello Comandi (fonte di verità)

> Documento di design per la riorganizzazione di creazione/gestione flotte.
> È la **fonte di verità unica** da cui pendono: il builder del modal, l'ingresso-da-mappa
> e la ri-validazione a runtime. Quando il codice e questo doc divergono, allinea il codice
> oppure aggiorna qui *prima* di cambiare comportamento.

---

## 1. Concetti

Ogni intento di flotta si compone di **primitive di movimento** + **azioni terminali**, accodate
manualmente dal giocatore, e ammesse solo se **coerenti** con l'oggetto di destinazione.

### Primitive di movimento

| Primitiva | Da → A | Precondizione | Esito | xp / rischio |
|---|---|---|---|---|
| **M1** — salto inter-sistema | sistema → **orbita generica** di un altro sistema | sistema *detected* | se *detected* lo **scopre**; se già esplorato → orbita generica | proporzionale agli **I totali** del viaggio |
| **M2** — manovra intra-sistema | orbita generica / porto → **orbita di un corpo** (pianeta/luna/anomalia/giacimento) | sistema **esplorato** (lista corpi nota) | orbita ancorata al corpo (`bodyKey`) | proporzionale agli I (ridotto; nullo se è tua colonia) |

- "Da porto a orbitare un corpo nella **mia stessa** colonia di partenza" = **M2 da solo** (nessun M1).
- "Vai a un altro sistema" = **M1 da solo** (ti fermi in orbita generica).
- "Vai al corpo X di un altro sistema esplorato" = **M1 + M2**.

### Azioni di 3° livello (terminali dove continuative)

| Azione | Tipo | Effetto | Continuativa? |
|---|---|---|---|
| **Attacca** | one-shot | viaggia/orbita e ingaggia il bersaglio al tick d'arrivo; poi resta in orbita | no (poi sosta) |
| **Colonizza** | multi-fase | viaggio → orbita → fondazione; al termine colonia operativa, flotta auto-park | no (poi sosta) |
| **Attracca** | istantanea | ormeggia in porto in una **tua** colonia | no |
| **Estrai** | continuativa | drena un **giacimento** (anomalia o corpo sfruttabile) finché presente; deposita in colonia | **sì → step finale** |
| **Ricognizione** | continuativa | costruisce/approfondisce il **dossier** di una civ AI / covo pirata per presenza | **sì → step finale** |
| *Difendi alleato* | *futura* | *unisce la forza alla difesa di un alleato sotto attacco* | *— (engine TODO)* |

> **"Resta in orbita" / "Presidia" / "Schiera in difesa" NON sono comandi.** Sono lo *stato di default*
> di una flotta ferma: si difende per presenza e ti allerta delle minacce automaticamente.

---

## 2. Stati e etichette (derivate)

Lo stato fisico nel dato resta `docked` / `in-transit` / `orbiting`. L'**etichetta** è derivata
da `fleetStance(f)` su `(status, location.bodyKey, orders, composizione)`:

| Condizione | Stato motore | Etichetta UI |
|---|---|---|
| In porto in una tua colonia | `docked` | **In porto** |
| Sta percorrendo un leg | `in-transit` | **In viaggio** |
| `bodyKey` valorizzato + azione continuativa (Estrai) | `orbiting` | **In estrazione su ‹corpo›** |
| `bodyKey` valorizzato, flotta armata, nessuna azione | `orbiting` | **In difesa di ‹corpo›** |
| `bodyKey` valorizzato, nessuna azione | `orbiting` | **In orbita di ‹corpo›** |
| Ferma a un sistema, nessun corpo, nessuna azione | `orbiting` | **In sosta** |

---

## 3. Regola di disponibilità

```
azioneDisponibile(A, oggetto, flotta) = gateOggetto(A, oggetto) && gateFlotta(A, flotta)
```

- **gateOggetto** — dipende da tipo/stato del corpo (vedi tabella master §5).
- **gateFlotta** — dipende dalla composizione:

| Azione | gateFlotta |
|---|---|
| Attacca | potenza di fuoco > 0 |
| Colonizza | ≥1 nave **coloniale** a bordo |
| Estrai | ≥1 **estrattore** (rate pieno) o **esploratore** (rate minimo); *reliquie*: nessun requisito (per presenza) |
| Attracca | — |
| Ricognizione | — (qualsiasi flotta; lo **score di composizione** determina la *velocità*, non il tetto) |
| *Difendi alleato* | *potenza di fuoco > 0 (futura)* |

### Dossier / intel (Ricognizione) — modello cumulativo

L'intel **non è cappato dalla composizione**: si accumula per presenza e persiste tra le visite.

```
civ.intelProgress / nest.intelProgress  (continuo, persistito, additivo)
   += rate per I di presenza (orbiting/docked),  rate = max(FLOOR, score × k)
livelli a soglia:  frammentario > 0 · parziale ≥ 3 · completo ≥ 6
```

- **Composizione = velocità/efficienza** (ammiraglia: completo in pochi I; esploratore: lento ma possibile).
- **Persistenza paga**: il `FLOOR` garantisce un guadagno minimo a ogni visita → grindabile con flotta minima.
- **Primo contatto** (knowledge → *contacted*) alla prima presenza ≥ `CONTACT_PRESENCE_I` (4 I).
- Al cap (*completo*) smette. Auto per presenza (recovery-friendly) **anche senza** comando Ricognizione;
  il comando rende l'intento esplicito, impegna la flotta e mostra il contatore.
- **UI**: contatore su scheda flotta + marker — `Dossier ‹civ›: ▮▮▯▯ n/soglia · livello: parziale`.

### Gate di conoscenza (controlla se M2 è proponibile)

| Stato sistema destinazione | Accodabile |
|---|---|
| *Detected* ma non esplorato | **solo M1** (niente M2: i corpi non sono ancora noti) |
| *Esplorato* | M1 + **M2** verso un corpo (lista dinamica dei corpi del sistema) |

---

## 4. Regole di accodamento

1. **Manuale**: il giocatore costruisce la catena; nessuna macro auto-compilata.
2. **Coerenza**: ogni step è offerto solo se valido per l'oggetto corrente (Gate A + Gate B).
3. **Azioni continuative terminali**: dopo Estrai non si accoda nulla.
4. **Edit/interruzione solo a fine step**: a ogni snodo (orbita raggiunta) puoi rieditare la coda
   da lì in avanti; gli step già completati restano.
5. **Rischio ∝ I**: un solo tiro/accumulo di rischio per *segmento di movimento continuo*
   (M1, o M1+M2 in fila), in funzione degli I totali. Il rischio specifico di un'Azione
   (es. danni in Attacca) è separato.
6. **Ri-validazione a runtime** (recovery-friendly #22): se il mondo cambia (AI sparita,
   giacimento esausto), l'Azione **decade con grazia** (la flotta resta in orbita) + evento
   in cronaca; mai fail-state.

### Ingresso-da-mappa

Cliccando un oggetto sulla mappa si apre **lo stesso modal** con la catena minima pre-montata:

- corpo preciso in sistema esplorato → `M1(sistema) + M2(corpo)` + Azioni valide per quel corpo;
- sistema solo *detected* → `M1` (lo scoprirai), nessun M2.

### Rotta avanzata / Pattuglia (opt-in)

Il flusso base è **una destinazione + un'azione** (90% dei casi). Un toggle esplicito
**"Rotta avanzata / Pattuglia"** (collassato di default) espande la stessa coda con:

- **più tappe** M1 in sequenza;
- **dwell per tappa** (pausa orbitale → durante la sosta l'intel/dossier si accumula per presenza);
- toggle **ciclica** (loop infinito → `patrol-loop`);
- toggle **rientro a fine** (`returnHome`).

Non è un secondo sistema: è la stessa coda con flag, mappata su `move-route` / `patrol-loop`.
Esempio "tieni 2 sistemi sotto controllo continuo": pattuglia ciclica A↔B con `dwell ≥` tempo
di ricognizione → dossier continuo su entrambi, hands-free.

---

## 5. Tabella master — corpo → M2 → Azioni

> Le **lune** seguono le stesse regole dei pianeti, per stato. Un'azione marcata *(futura)*
> ha gate definito ma motore non ancora implementato.

| Oggetto (target M2) | M2 ammesso | Azioni ammesse | gateFlotta richiesto | Produzione / effetto |
|---|---|---|---|---|
| **Tua colonia** (pianeta/luna colonizzata) | sì | **Attracca** · *Difendi alleato n/a* | — | ormeggio in porto; carico viveri; riparazione |
| **Pianeta/luna colonizzabile libero** (no AI) | sì | **Colonizza** | coloniale | fonda colonia (3 fasi), poi auto-park |
| **Corpo con giacimento** (pianeta/luna non colonizzabile sfruttabile) | sì | **Estrai** | estrattore/esploratore | drena `giacimento.res` → deposita in colonia origine |
| **Anomalia — detriti** | sì | **Estrai** | estrattore/esploratore | → **met** |
| **Anomalia — nebulosa** | sì | **Estrai** | estrattore/esploratore | → **en** |
| **Anomalia — reliquie** | sì | **Estrai** (esplora) | nessuno (per presenza) | progress → bottino una-tantum multi-risorsa |
| **Pianeta/colonia AI ostile o attaccabile** | sì | **Attacca** · **Ricognizione** | Attacca: fuoco · Ricognizione: — | scaramuccia / costruisce dossier |
| **Pianeta/colonia AI alleata** (sotto minaccia) | sì | **Ricognizione** · *Difendi alleato (futura)* | Ricogn.: — · Difesa: fuoco | dossier / *difesa (engine TODO)* |
| **Pianeta/luna neutrale inerte** (no AI, no giacimento, non colonizzabile) | sì | *(nessuna)* → solo sosta/orbita | — | vigilanza per presenza |
| **Covo pirata** | sì | **Attacca** · **Ricognizione** | Attacca: fuoco · Ricognizione: — | distrugge il covo / dossier covo |
| **Anomalia/corpo in sistema solo detected** | **no** | — | — | esplora prima (M1) |

### Combattimento — partecipazione

- Si combatte **per presenza nel sistema** (flotta ferma + armata + presenza ostile),
  **non** per orbita del corpo specifico. Una **tua stazione** nel sistema combatte al tuo fianco.
- Nessuna scaramuccia nel sistema di una **tua** colonia (lì è assedio).
- **Difesa di un alleato AI**: non implementata (i conflitti AI-vs-AI sono astratti, a `power`).
  Resta come slot futuro.

---

## 6. Impatto sul modello dati (additivo, lazy)

- `fleet.queue = []` — step successivi all'ordine corrente (`fleet.orders` resta lo step attivo).
- **Giacimenti su corpi** (decisione A): derivati dal seed via `ORION.anomaly.bodyGiacimento(body)`.
  Corpi non colonizzabili sfruttabili: **cintura → met**, **gigante gassoso → en** (stesso modello
  `perBody` di raccolta delle anomalie; nessun campo nuovo nel save, il sito vive in `game.anomalies`).
- `fleetStance(f)` — helper di etichetta derivata (nessun nuovo campo persistito).
- Allerta minacce: **sempre attiva** per ora (toggle per-flotta rinviato).
- Schema: bump con sub-migrazione lazy (`queue` lazy-init), non distruttiva.

---

## 7. Riepilogo verbi esposti al giocatore

**Movimento:** M1 (vai al sistema) · M2 (vai al corpo) · *Rotta avanzata/Pattuglia (opt-in)*
**Azioni:** Attacca · Colonizza · Attracca · Estrai · Ricognizione *(+ Difendi alleato, futura)*
**Default (non comandi):** sosta · vigilanza/difesa per presenza · intel-by-presence · rientro come azione rapida
