/**
 * LupusEngine — il "motore delle regole" di Lupus.
 *
 * Principio guida: questo file non tocca MAI il DOM (nessun document.*,
 * nessun window.* a parte l'esportazione stessa) e non legge variabili
 * globali implicite — ogni funzione riceve i dati di cui ha bisogno come
 * parametro e restituisce un risultato, senza effetti collaterali nascosti.
 *
 * Perché: è la parte di Lupus che, se un giorno diventerà multiplayer,
 * dovrà girare su un server (perché decide chi vince, chi è vivo, chi si
 * sveglia — cose che un client non può decidere da solo per un gruppo di
 * sconosciuti). Tenendola separata da subito, il giorno in cui servirà
 * spostarla su un backend Node.js basterà includere questo stesso file
 * con require(), senza doverlo riscrivere.
 *
 * Il resto del sito (index.html) resta responsabile di tutto ciò che questo
 * file NON fa: leggere/scrivere il DOM, gestire localStorage, animazioni,
 * navigazione tra le scene. Chiama le funzioni qui sotto per "sapere cosa
 * fare", poi decide da solo "come mostrarlo".
 */
(function(root, factory){
    if(typeof module !== 'undefined' && module.exports){
        // ambiente Node.js (es. un futuro backend) — modulo CommonJS
        module.exports = factory();
    } else {
        // ambiente browser — variabile globale
        root.LupusEngine = factory();
    }
})(typeof self !== 'undefined' ? self : this, function(){
    'use strict';

    /* ==========================================================
       UTILITÀ GENERICHE
       ========================================================== */

    // Mescola un array senza modificare l'originale (Fisher-Yates).
    function shuffleArray(array){
        var arr = array.slice();
        for(var i = arr.length - 1; i > 0; i--){
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
    }

    /* ==========================================================
       COMPOSIZIONE DELLA PARTITA
       ========================================================== */

    /**
     * Costruisce l'elenco dei ruoli della partita (con le ripetizioni per
     * lupo/contadino/massone) a partire da quali ruoli sono selezionati.
     * @param {string[]} ordineRuoli - gli id dei ruoli, nell'ordine della griglia
     * @param {Object.<string,boolean>} selezionati - mappa id -> selezionato o no
     * @param {{lupi:number, contadini:number, massoni:number}} conteggi
     * @returns {string[]} l'elenco (non ancora mescolato) dei ruoli della partita
     */
    function componiRuoliPartita(ordineRuoli, selezionati, conteggi){
        var ruoliPartita = [];
        ordineRuoli.forEach(function(id){
            if(!selezionati[id]) return;
            if(id === 'lupo'){
                for(var i = 0; i < (conteggi.lupi || 0); i++) ruoliPartita.push(id);
            } else if(id === 'contadino'){
                for(var j = 0; j < (conteggi.contadini || 0); j++) ruoliPartita.push(id);
            } else if(id === 'massone'){
                for(var k = 0; k < (conteggi.massoni || 0); k++) ruoliPartita.push(id);
            } else {
                ruoliPartita.push(id);
            }
        });
        return ruoliPartita;
    }

    /* ==========================================================
       CRITERIO DI VEGLIA — quando un ruolo si sveglia di notte
       ========================================================== */

    var ETICHETTE_SVEGLIA = {
        sempre: 'Si sveglia ogni notte',
        mai: 'Non si sveglia mai di notte',
        solo_prima: 'Si sveglia solo la prima notte',
        solo_seconda: 'Si sveglia solo la seconda notte',
        dopo_morte: 'Si sveglia dalla notte successiva alla prima morte',
        finche_non_usato: 'Si sveglia ogni notte finché non usa il potere'
    };

    // Descrizione leggibile del criterio di veglia di un ruolo (usata sia nel
    // popup informativo sia sul retro della carta).
    function etichettaSveglia(ruolo){
        var s = (ruolo && ruolo.sveglia) || {tipo: 'sempre'};
        switch(s.tipo){
            case 'intervallo':
                var da = s.da || 1;
                if(s.a === undefined || s.a === null || s.a === ''){
                    return da <= 1 ? ETICHETTE_SVEGLIA.sempre : 'Si sveglia dalla notte ' + da + ' in poi';
                }
                return 'Si sveglia dalla notte ' + da + ' alla notte ' + s.a;
            case 'notti_specifiche':
                var elenco = (s.notti || []).join(', ');
                return 'Si sveglia solo nelle notti: ' + (elenco || '—');
            default:
                return ETICHETTE_SVEGLIA[s.tipo] || '';
        }
    }

    // true se almeno un giocatore, in precedenza, è morto.
    function mortoStorico(playerAlive){
        return playerAlive.some(function(v){ return v === false; });
    }

    /**
     * Decide se un ruolo va chiamato la notte indicata. Nota: la decisione
     * dipende SOLO dalla tempistica (tipo di sveglia, notte, eventuale morte
     * pregressa) — mai da chi è vivo o morto in quel momento, perché un ruolo
     * va comunque chiamato anche se chi lo interpreta è morto (altrimenti il
     * silenzio del narratore rivelerebbe la morte).
     * @param {Object} ruolo - il ruolo (deve avere il campo "sveglia")
     * @param {{notte:number, playerAlive:boolean[], usatoRuolo:Object}} stato
     */
    function ruoloSvegliaStanotte(ruolo, stato){
        var s = ruolo.sveglia || {tipo: 'sempre'};
        var notte = stato.notte;
        switch(s.tipo){
            case 'sempre': return true;
            case 'mai': return false;
            case 'solo_prima': return notte === 1;
            case 'solo_seconda': return notte === 2;
            case 'dopo_morte': return notte > 1 && mortoStorico(stato.playerAlive);
            case 'finche_non_usato': return !stato.usatoRuolo[ruolo.id];
            case 'intervallo':
                var da = s.da || 1;
                var a = (s.a === undefined || s.a === null || s.a === '') ? Infinity : s.a;
                return notte >= da && notte <= a;
            case 'notti_specifiche':
                return (s.notti || []).indexOf(notte) !== -1;
            default: return true;
        }
    }

    /**
     * Calcola la lista ordinata dei ruoli da chiamare questa notte, con i
     * giocatori (vivi e morti) che li interpretano. Nessun DOM: restituisce
     * solo dati, sarà index.html a trasformarli in HTML.
     * @returns {Array<{id:string, ruolo:Object, giocatori:Array<{nome:string, vivo:boolean}>, tuttiMorti:boolean}>}
     */
    function calcolaListaNotte(ruoliPartita, giocatori, playerAlive, roles, stato){
        var presenti = {};
        ruoliPartita.forEach(function(id, idx){
            if(!presenti[id]) presenti[id] = [];
            presenti[id].push({ nome: giocatori[idx], vivo: playerAlive[idx] !== false });
        });

        var idsOrdinati = Object.keys(presenti).filter(function(id){
            return ruoloSvegliaStanotte(roles[id], stato);
        }).sort(function(a, b){
            var oa = (roles[a].ordine_notte !== undefined && roles[a].ordine_notte !== null) ? roles[a].ordine_notte : 9999;
            var ob = (roles[b].ordine_notte !== undefined && roles[b].ordine_notte !== null) ? roles[b].ordine_notte : 9999;
            return oa - ob;
        });

        return idsOrdinati.map(function(id){
            var elenco = presenti[id];
            return {
                id: id,
                ruolo: roles[id],
                giocatori: elenco,
                tuttiMorti: elenco.every(function(p){ return !p.vivo; })
            };
        });
    }

    /* ==========================================================
       RUOLI PERSONALIZZATI E DESCRIZIONI
       ========================================================== */

    // Genera un id leggibile e univoco a partire dal nome di un ruolo personalizzato.
    function generaIdRuolo(nome, ruoliEsistenti){
        var base = nome.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        if(!base) base = 'ruolo';
        var id = base, n = 2;
        while(ruoliEsistenti[id]){ id = base + '-' + n; n++; }
        return id;
    }

    // La descrizione "vera" di un ruolo per la partita in corso: quella
    // modificata dall'utente se esiste, altrimenti quella originale.
    function descrizioneEffettiva(id, roles, descrizioniPartita){
        if(descrizioniPartita[id] !== undefined) return descrizioniPartita[id];
        return roles[id] ? roles[id].descrizione : '';
    }

    /* ==========================================================
       NARRATORE AUTOMATICO — risoluzione delle azioni notturne
       (vale solo per partite senza ruoli personalizzati: qui sotto si
       ragiona per id di ruolo fissi, presi da roles.json)
       ========================================================== */

    // Indice (0-based, stesso ordine di "giocatori"/join della stanza) del
    // primo giocatore che interpreta ATTUALMENTE un certo ruolo, o -1.
    function trovaIndiceRuolo(ruoli, ruoloId){
        for(var i = 0; i < ruoli.length; i++){
            if(ruoli[i] === ruoloId) return i;
        }
        return -1;
    }

    // Come trovaIndiceRuolo, ma restituisce TUTTI gli indici (utile per i
    // Massoni, che possono essere più di uno in partita e devono
    // riconoscersi a vicenda la prima notte).
    function trovaIndiciRuolo(ruoli, ruoloId){
        var indici = [];
        for(var i = 0; i < ruoli.length; i++){
            if(ruoli[i] === ruoloId) indici.push(i);
        }
        return indici;
    }

    // Cosa "vede" la veggente/il medium su un ruolo: buono/cattivo in base
    // alla squadra, con il Matto trattato a parte solo per il medium.
    function allineamentoVisibile(ruoloId, roles){
        if(ruoloId === 'matto') return 'matto';
        var ruolo = roles[ruoloId];
        return (ruolo && ruolo.squadra === 'cattivi') ? 'cattivo' : 'buono';
    }

    function clonaStatoPartita(s){
        return {
            ruoli: s.ruoli.slice(),
            vivo: s.vivo.slice(),
            causaMorte: s.causaMorte.slice(),
            viteDruido: s.viteDruido.slice(),
            finteMorto: s.finteMorto.slice(),
            angeloVivoIdx: s.angeloVivoIdx,
            angeloProtettoIdx: s.angeloProtettoIdx,
            guardiaUltimoProtetto: s.guardiaUltimoProtetto,
            fantasmaTargetIdx: s.fantasmaTargetIdx,
            fantasmaStreak: s.fantasmaStreak,
            senzaVoltoResuscitati: s.senzaVoltoResuscitati.slice(),
            // Indici dei giocatori che lo Spaccino ha già indicato in una
            // notte precedente: può indicare ciascun giocatore una sola
            // volta in tutta la partita, mai due volte lo stesso.
            spaccinoBersagliUsati: s.spaccinoBersagliUsati.slice(),
            neomelodicoUsato: s.neomelodicoUsato,
            mortiProgrammate: s.mortiProgrammate.slice(),
            mortiUltimoGiro: s.mortiUltimoGiro.slice(),
            notte: s.notte
        };
    }

    // Stato iniziale (prima della notte 1) a partire dai ruoli assegnati,
    // nello stesso ordine dei giocatori/join della stanza.
    function creaStatoPartita(ruoliIniziali){
        return {
            ruoli: ruoliIniziali.slice(),
            vivo: ruoliIniziali.map(function(){ return true; }),
            causaMorte: ruoliIniziali.map(function(){ return null; }),
            // Il Druido ha una vita in più, ma solo contro gli attacchi dei lupi.
            viteDruido: ruoliIniziali.map(function(id){ return id === 'druido' ? 2 : 1; }),
            finteMorto: ruoliIniziali.map(function(){ return false; }),
            angeloVivoIdx: null,
            angeloProtettoIdx: null,
            guardiaUltimoProtetto: null,
            fantasmaTargetIdx: null,
            fantasmaStreak: 0,
            // Indici (distinti) dei giocatori che il Senza Volto è
            // riuscito a resuscitare finora, in tutta la partita: vince
            // alla terza persona DIVERSA, non alla terza resurrezione in
            // assoluto (resuscitare due volte lo stesso non vale doppio).
            senzaVoltoResuscitati: [],
            spaccinoBersagliUsati: [],
            neomelodicoUsato: false,
            mortiProgrammate: [],
            // Chi è morto "di recente" (la notte appena trascorsa più
            // l'eventuale voto del giorno successivo), per il Senza Volto:
            // si azzera e si ricostruisce da capo a ogni notte (vedi
            // risolviNotte), applicaMorte ci accoda ogni morte reale
            // (notturna o diurna) man mano che avviene.
            mortiUltimoGiro: [],
            notte: 1
        };
    }

    // L'Inquisitore, di giorno, può condannare un lupo che non risponde:
    // "morirà la notte seguente". Si accoda qui e si applica in cima alla
    // notte successiva (vedi risolviNotte), non è una morte immediata.
    function programmaMorte(stato, giocatoreIdx, causa){
        var s = clonaStatoPartita(stato);
        s.mortiProgrammate.push({ giocatoreIdx: giocatoreIdx, causa: causa });
        return s;
    }

    /**
     * Applica una morte, gestendo le due sostituzioni passive già previste
     * dai ruoli: l'Angelo (muore lui al posto del protetto, per qualsiasi
     * causa, finché è vivo) e il Druido (seconda vita, ma solo se causa
     * è 'lupi'). Usata sia per le morti notturne che per quelle diurne
     * (voto del villaggio, fucilata del cacciatore) registrate dal
     * narratore-proxy: è l'unico punto in cui una morte viene "decisa" —
     * ed è anche l'unico punto che alimenta mortiUltimoGiro (vedi
     * creaStatoPartita/risolviNotte), a prescindere che la morte sia
     * notturna o diurna.
     * @returns {{stato:Object, mortoIdx:(number|null), vittoria:(Object|null)}}
     */
    function applicaMorte(stato, vittimaIdx, causa){
        if(vittimaIdx === null || vittimaIdx === undefined){
            return { stato: stato, mortoIdx: null, vittoria: null };
        }
        var s = clonaStatoPartita(stato);
        var idxReale = vittimaIdx;

        if(s.angeloProtettoIdx === idxReale && s.angeloVivoIdx !== null &&
           s.vivo[s.angeloVivoIdx] && s.angeloVivoIdx !== idxReale){
            idxReale = s.angeloVivoIdx;
        }

        if(causa === 'lupi' && s.ruoli[idxReale] === 'druido' && s.viteDruido[idxReale] > 1){
            s.viteDruido[idxReale]--;
            return { stato: s, mortoIdx: null, vittoria: null };
        }

        s.vivo[idxReale] = false;
        s.causaMorte[idxReale] = causa;
        // Ogni morte reale (notturna o diurna) entra nella finestra che il
        // Senza Volto può scegliere: si azzera da sola a ogni nuova notte
        // (vedi risolviNotte), quindi qui basta accodare.
        if(s.mortiUltimoGiro.indexOf(idxReale) === -1) s.mortiUltimoGiro.push(idxReale);

        // Il Matto vince solo se la morte arriva dal voto del villaggio, non
        // se lo spara il cacciatore ("se uccide il matto, il matto non vince").
        var vittoria = (s.ruoli[idxReale] === 'matto' && causa === 'voto')
            ? { tipo: 'matto', giocatoreIdx: idxReale }
            : null;

        return { stato: s, mortoIdx: idxReale, vittoria: vittoria };
    }

    /**
     * Unanimità del voto dei lupi: risolve subito se tutti i lupi vivi hanno
     * votato lo stesso bersaglio, va richiamata ad ogni nuovo voto. Ritorna
     * l'indice del bersaglio oppure null se non ancora raggiunta.
     * @param {Array<{giocatoreIdx:number, bersaglioIdx:number}>} voti
     * @param {number[]} lupiVivi - indici dei lupi attualmente vivi
     */
    function risolviVotoLupi(voti, lupiVivi){
        if(lupiVivi.length === 0) return null;
        var validi = voti.filter(function(v){ return lupiVivi.indexOf(v.giocatoreIdx) !== -1; });
        if(validi.length !== lupiVivi.length) return null;
        var primo = validi[0].bersaglioIdx;
        var unanime = validi.every(function(v){ return v.bersaglioIdx === primo; });
        return unanime ? primo : null;
    }

    /**
     * Da chiamare alla scadenza del timer se non si è raggiunta l'unanimità:
     * vince la maggioranza dei voti espressi, in caso di parità vince il
     * bersaglio del primo che ha votato (in ordine di tempo). Se nessun lupo
     * ha votato, nessuna vittima stanotte.
     * @param {Array<{giocatoreIdx:number, bersaglioIdx:number, ts:number}>} voti
     * @param {number[]} lupiVivi
     */
    function risolviVotoLupiConScadenza(voti, lupiVivi){
        var validi = voti.filter(function(v){ return lupiVivi.indexOf(v.giocatoreIdx) !== -1; });
        if(validi.length === 0) return null;

        var conteggio = {};
        validi.forEach(function(v){
            conteggio[v.bersaglioIdx] = (conteggio[v.bersaglioIdx] || 0) + 1;
        });
        var maxVoti = -1, maggioranza = null, pareggio = false;
        Object.keys(conteggio).forEach(function(bersaglio){
            var n = conteggio[bersaglio];
            if(n > maxVoti){ maxVoti = n; maggioranza = Number(bersaglio); pareggio = false; }
            else if(n === maxVoti){ pareggio = true; }
        });
        if(!pareggio) return maggioranza;

        var primoVoto = validi.slice().sort(function(a, b){ return a.ts - b.ts; })[0];
        return primoVoto.bersaglioIdx;
    }

    /**
     * Vittoria di SQUADRA (non individuale): i buoni vincono se non è
     * rimasto in vita nessun cattivo, i cattivi vincono se non è rimasto in
     * vita nessun buono. I ruoli neutrali (Matto, Fantasma, SenzaVolto,
     * Criceto Mannaro, Mitomane non ancora convertito, ...) non contano per
     * nessuna delle due squadre: la partita continua per loro anche se una
     * delle due squadre "principali" si estinguesse, finché non vincono a
     * loro volta o l'ultimo giocatore neutrale resta comunque solo.
     * Va richiamata dopo ogni morte (notturna o diurna) in aggiunta alle
     * vittorie individuali già gestite da applicaMorte/risolviNotte.
     */
    function calcolaVittoriaSquadre(stato, roles){
        var buoniVivi = 0, cattiviVivi = 0;
        stato.ruoli.forEach(function(ruoloId, idx){
            if(!stato.vivo[idx]) return;
            var squadra = roles[ruoloId] && roles[ruoloId].squadra;
            if(squadra === 'buoni') buoniVivi++;
            else if(squadra === 'cattivi') cattiviVivi++;
        });
        if(cattiviVivi === 0 && buoniVivi > 0) return { tipo: 'buoni' };
        if(buoniVivi === 0 && cattiviVivi > 0) return { tipo: 'cattivi' };
        return null;
    }

    /**
     * Il Criceto Mannaro vince da solo se è ancora vivo quando la partita
     * finisce, a prescindere da chiunque altro abbia vinto: non anticipa né
     * forza mai la fine della partita da solo, si limita a "dirottare" su di
     * sé l'esito quando una vittoria (di squadra o individuale) sta per
     * essere dichiarata comunque. Va richiamata su ogni vittoria proposta,
     * poco prima di mostrarla, sia in locale che in remoto.
     * @param {Object|null} vittoriaProposta - l'esito che si stava per dichiarare
     * @returns {Object|null} la vittoria da mostrare davvero
     */
    function vittoriaFinale(stato, roles, vittoriaProposta){
        if(!vittoriaProposta) return vittoriaProposta;
        var idx = trovaIndiceRuolo(stato.ruoli, 'cricetoMannaro');
        if(idx !== -1 && stato.vivo[idx]){
            return { tipo: 'cricetoMannaro', giocatoreIdx: idx };
        }
        return vittoriaProposta;
    }

    // Verifica che chi dichiara di interpretare un ruolo (bottone "Rivelati"
    // di Cacciatore/Inquisitore) lo interpreti davvero, prima di rendere
    // pubblica la rivelazione — così il narratore-proxy non deve fidarsi
    // sulla parola del giocatore.
    function verificaRuoloReale(stato, giocatoreIdx, ruoloAtteso){
        return stato.ruoli[giocatoreIdx] === ruoloAtteso;
    }

    /**
     * L'Inquisitore, una sola volta a partita, chiede a un giocatore se è
     * Lupo: quello è costretto a rispondere con la verità (nessuna scelta di
     * tacere, a differenza della vecchia regola). Risposta basata sul ruolo
     * REALE del bersaglio (non su allineamentoVisibile: è una domanda
     * diretta "sei Lupo?", non la percezione della Veggente — l'Indemoniato,
     * pur giocando con i lupi, risponderebbe onestamente "no"). Usato il
     * potere, l'Inquisitore diventa un semplice Contadino.
     * @returns {{stato:Object, eLupo:boolean}}
     */
    function interrogaInquisitore(stato, inquisitoreIdx, bersaglioIdx){
        var s = clonaStatoPartita(stato);
        var eLupo = s.ruoli[bersaglioIdx] === 'lupo';
        s.ruoli[inquisitoreIdx] = 'contadino';
        return { stato: s, eLupo: eLupo };
    }

    /**
     * Risolve un'intera notte a partire dalle azioni raccolte da ogni ruolo
     * (il voto dei lupi arriva già deciso da risolviVotoLupi/ConScadenza; la
     * conversione del Mitomane e tutto il resto si risolve qui). Non tocca
     * mai il DOM: chi la chiama (oggi, il dispositivo del narratore) scrive
     * poi il risultato su Firebase.
     *
     * @param {Object} stato - da creaStatoPartita() o dalla notte precedente
     * @param {Object} azioni - bersagli scelti stanotte, per ruolo (id
     *   giocatore = indice nell'array "ruoli", stesso ordine di join stanza):
     *   illusionistaBersaglioIdx, spaccinoBersaglioIdx, mitomaneBersaglioIdx
     *   (solo notte 2), lupiVittimaIdx (già risolto), insinuoBersaglioIdx,
     *   veggenteBersaglioIdx, guardiaBersaglioIdx, mediumBersaglioIdx,
     *   angeloBersaglioIdx (solo notte 1), puttanaBersaglioIdx,
     *   senzaVoltoBersaglioIdx, neomelodicoAttivato (bool),
     *   fantasmaBersaglioIdx, suicidaAzione ('finto'|'resuscita'|null)
     * @param {Object} roles - ROLES di roles.json (id -> definizione ruolo)
     * @returns {{stato:Object, morti:Array, rivelazioni:Object, eventi:Array, vittoria:(Object|null)}}
     */
    function risolviNotte(stato, azioni, roles){
        var s = clonaStatoPartita(stato);
        var n = s.ruoli.length;
        var morti = [];
        var rivelazioni = {};
        var eventi = [];
        var vittoriaAutomatica = null;

        // Il Senza Volto può scegliere solo fra chi è morto nella finestra
        // "notte scorsa + giorno scorso" (mortiUltimoGiro, alimentata da
        // applicaMorte): la salviamo qui PRIMA di azzerarla, perché da
        // adesso in poi deve ricominciare ad accumulare solo le morti di
        // STANOTTE (per la prossima notte).
        var mortiFinestraPrecedente = s.mortiUltimoGiro;
        s.mortiUltimoGiro = [];

        // Fotografia di chi era vivo PRIMA di qualunque azione di stanotte
        // (morti programmate comprese, oggi di fatto sempre vuote da quando
        // l'Inquisitore non ne genera più — vedi interrogaInquisitore):
        // usata da inattivo() invece di s.vivo, che muta durante la notte.
        var vivoInizioNotte = s.vivo.slice();

        // Illusionista e Spaccino contano solo se chi li interpreta è vivo e
        // non ha indicato sé stesso (nessuno può usare il proprio potere su
        // di sé): in quel caso il potere semplicemente non ha alcun effetto.
        var illusionistaIdxAttore = trovaIndiceRuolo(s.ruoli, 'illusionista');
        var illusionistaAttivo = illusionistaIdxAttore !== -1 && s.vivo[illusionistaIdxAttore] &&
            azioni.illusionistaBersaglioIdx !== illusionistaIdxAttore;
        var spaccinoIdxAttore = trovaIndiceRuolo(s.ruoli, 'spaccino');
        var spaccinoAttivo = spaccinoIdxAttore !== -1 && s.vivo[spaccinoIdxAttore] &&
            azioni.spaccinoBersaglioIdx !== spaccinoIdxAttore;
        // Può indicare un giocatore solo una volta in tutta la partita: qui
        // registriamo soltanto (l'interfaccia è responsabile di non
        // riproporre chi è già in questa lista come bersaglio scelto).
        if(spaccinoAttivo && s.spaccinoBersagliUsati.indexOf(azioni.spaccinoBersaglioIdx) === -1){
            s.spaccinoBersagliUsati.push(azioni.spaccinoBersaglioIdx);
        }

        // Un ruolo non ha effetto stanotte se chi lo interpreta era GIÀ morto
        // PRIMA di stanotte (va comunque "chiamato" dalla UI, per non
        // rivelarne la morte col silenzio, ma la sua azione non deve produrre
        // nulla) o se è il bersaglio dell'Illusionista. Usiamo apposta una
        // fotografia di s.vivo presa a inizio notte (vivoInizioNotte, sotto)
        // e non s.vivo in tempo reale: altrimenti un ruolo risolto DOPO che
        // un altro potere lo ha ucciso questa stessa notte (es. il Medium
        // dopo l'attacco dei lupi) risulterebbe erroneamente "già morto" e
        // perderebbe il potere che stanotte gli spetta ancora.
        function inattivo(idx){
            return idx === -1 || !vivoInizioNotte[idx] || (illusionistaAttivo && azioni.illusionistaBersaglioIdx === idx);
        }
        // Se lo Spaccino droga chi ESERCITA un potere "su qualcuno" (Guardia,
        // Puttana, SenzaVolto, Fantasma — i Lupi sono un caso a parte, vedi
        // vittimaLupi, perché è un potere collettivo non di un singolo
        // attore), quel potere non colpisce chi hanno scelto ma la persona
        // alla sua destra — il prossimo indice nell'ordine di ingresso in
        // stanza, usato come cerchio virtuale dei posti a sedere.
        function conRedirect(idxAttore, idxBersaglio){
            if(spaccinoAttivo && idxAttore === azioni.spaccinoBersaglioIdx &&
               idxBersaglio !== null && idxBersaglio !== undefined){
                return (idxBersaglio + 1) % n;
            }
            return idxBersaglio;
        }
        // Chi ha un potere di osservazione (Veggente, Medium): se è LUI il
        // bersaglio dello Spaccino, è la sua stessa percezione quella
        // notte a essere invertita — non importa chi stia controllando, è
        // lui ad "essere drogato" e a percepire il contrario del vero (es.
        // se lo Spaccino indica la Veggente, lei vedrà i lupi come buoni).
        function conInversione(risultatoBool, idxAttore){
            return (spaccinoAttivo && idxAttore === azioni.spaccinoBersaglioIdx) ? !risultatoBool : risultatoBool;
        }
        function registraMorte(idx, causa){
            if(idx === null || idx === undefined) return null;
            if(nottePacifica) return null;
            if(s.vivo[idx] === false) return null; // già morto per davvero, non si conta due volte
            // Fantasma e Criceto Mannaro non possono essere uccisi dai lupi
            // (vale per l'attacco diretto e per la morte "condivisa" della
            // Puttana, uniche due vie da cui arriva causa 'lupi').
            if(causa === 'lupi' && (s.ruoli[idx] === 'fantasma' || s.ruoli[idx] === 'cricetoMannaro')) return null;
            var esito = applicaMorte(s, idx, causa);
            s = esito.stato;
            if(esito.mortoIdx !== null) morti.push({ giocatoreIdx: esito.mortoIdx, causa: causa });
            if(esito.vittoria) vittoriaAutomatica = esito.vittoria;
            return esito.mortoIdx;
        }

        var veggenteIdx = trovaIndiceRuolo(s.ruoli, 'veggente');

        // --- Neomelodico: si decide subito, perché annulla TUTTE le morti
        //     di questa notte, comprese quelle risolte più avanti qui sotto.
        var nottePacifica = false;
        var neomelodicoIdx = trovaIndiceRuolo(s.ruoli, 'neomelodico');
        if(azioni.neomelodicoAttivato && !s.neomelodicoUsato &&
           neomelodicoIdx !== -1 && !inattivo(neomelodicoIdx)){
            nottePacifica = true;
            s.neomelodicoUsato = true;
        }

        // --- Morti programmate la notte precedente (es. dall'Inquisitore) ---
        var mortiProgrammate = s.mortiProgrammate;
        s.mortiProgrammate = [];
        mortiProgrammate.forEach(function(m){ registraMorte(m.giocatoreIdx, m.causa); });

        // --- Angelo (solo notte 1): protezione permanente, per qualsiasi
        //     causa. Va deciso PRIMA di ogni altra azione di questa stessa
        //     notte (Veggente compresa): l'Angelo sceglie solo la notte 1,
        //     quindi se la sua protezione fosse registrata più avanti in
        //     questa funzione, un'altra azione risolta prima di lui in
        //     QUESTA notte (es. la morte istantanea causata dalla Veggente
        //     su Senza Volto/Criceto Mannaro/Fantasma) non la vedrebbe
        //     ancora — proprio il bug segnalato dall'utente.
        var angeloIdx = trovaIndiceRuolo(s.ruoli, 'angelo');
        if(s.notte === 1 && angeloIdx !== -1 && !inattivo(angeloIdx) && azioni.angeloBersaglioIdx !== angeloIdx &&
           azioni.angeloBersaglioIdx !== null && azioni.angeloBersaglioIdx !== undefined){
            s.angeloVivoIdx = angeloIdx;
            s.angeloProtettoIdx = azioni.angeloBersaglioIdx;
        }

        // --- Mitomane (solo notte 2): cambia ruolo in base al bersaglio ---
        var mitomaneIdx = trovaIndiceRuolo(s.ruoli, 'mitomane');
        if(mitomaneIdx !== -1 && !inattivo(mitomaneIdx) && azioni.mitomaneBersaglioIdx !== mitomaneIdx &&
           azioni.mitomaneBersaglioIdx !== null && azioni.mitomaneBersaglioIdx !== undefined){
            var ruoloVisto = s.ruoli[azioni.mitomaneBersaglioIdx];
            if(ruoloVisto === 'lupo' || ruoloVisto === 'veggente'){
                s.ruoli[mitomaneIdx] = ruoloVisto;
            } else {
                s.ruoli[mitomaneIdx] = 'contadino';
            }
            rivelazioni.mitomane = { nuovoRuolo: s.ruoli[mitomaneIdx] };
        }

        // --- Insinuo: il suo bersaglio risulterà "cattivo" alla veggente ---
        var insinuoIdx = trovaIndiceRuolo(s.ruoli, 'insinuo');
        var insinuoAttivo = insinuoIdx !== -1 && !inattivo(insinuoIdx) && azioni.insinuoBersaglioIdx !== insinuoIdx &&
            azioni.insinuoBersaglioIdx !== null && azioni.insinuoBersaglioIdx !== undefined;

        // --- Veggente ---
        if(veggenteIdx !== -1 && !inattivo(veggenteIdx) && azioni.veggenteBersaglioIdx !== veggenteIdx &&
           azioni.veggenteBersaglioIdx !== null && azioni.veggenteBersaglioIdx !== undefined){
            var bersaglioV = azioni.veggenteBersaglioIdx;
            var ruoloBersaglioV = s.ruoli[bersaglioV];
            var cattivo = (insinuoAttivo && bersaglioV === azioni.insinuoBersaglioIdx)
                ? true
                : (allineamentoVisibile(ruoloBersaglioV, roles) === 'cattivo');
            cattivo = conInversione(cattivo, veggenteIdx);
            rivelazioni.veggente = { bersaglioIdx: bersaglioV, cattivo: cattivo };

            // Chi viene "controllato" dalla veggente muore, a prescindere
            // dall'esito mostratole: SenzaVolto, Criceto Mannaro, Fantasma.
            if(ruoloBersaglioV === 'senzaVolto' || ruoloBersaglioV === 'cricetoMannaro' || ruoloBersaglioV === 'fantasma'){
                registraMorte(bersaglioV, 'veggente');
            }
        }

        // --- Lupi: la vittima arriva già decisa dal voto ---
        // Il potere dello Spaccino vale anche sui Lupi: se droga uno di
        // loro (un potere collettivo, non di un singolo attore come gli
        // altri ruoli qui sotto), la vittima scelta dal branco non muore,
        // muore invece la persona alla sua destra.
        var spaccinoSuLupo = spaccinoAttivo && s.ruoli[azioni.spaccinoBersaglioIdx] === 'lupo';
        var vittimaLupi = (azioni.lupiVittimaIdx !== null && azioni.lupiVittimaIdx !== undefined)
            ? (spaccinoSuLupo ? (azioni.lupiVittimaIdx + 1) % n : azioni.lupiVittimaIdx)
            : null;

        // --- Guardia ---
        // La Guardia può proteggere anche sé stessa (unica eccezione alla
        // regola "nessun potere su di sé"), ma non la stessa persona di due
        // notti di fila: se ci riprova, il potere semplicemente non ha effetto.
        var guardiaIdx = trovaIndiceRuolo(s.ruoli, 'guardia');
        var guardiaSalva = false;
        if(guardiaIdx !== -1 && !inattivo(guardiaIdx) &&
           azioni.guardiaBersaglioIdx !== null && azioni.guardiaBersaglioIdx !== undefined &&
           azioni.guardiaBersaglioIdx !== s.guardiaUltimoProtetto){
            if(conRedirect(guardiaIdx, azioni.guardiaBersaglioIdx) === vittimaLupi) guardiaSalva = true;
            s.guardiaUltimoProtetto = azioni.guardiaBersaglioIdx;
        }

        // --- Puttana ---
        var puttanaIdx = trovaIndiceRuolo(s.ruoli, 'puttana');
        var puttanaSalva = false;
        var puttanaMuoreConProtetto = null;
        if(puttanaIdx !== -1 && !inattivo(puttanaIdx) && azioni.puttanaBersaglioIdx !== puttanaIdx &&
           azioni.puttanaBersaglioIdx !== null && azioni.puttanaBersaglioIdx !== undefined){
            var protettoPuttana = conRedirect(puttanaIdx, azioni.puttanaBersaglioIdx);
            if(vittimaLupi === puttanaIdx){
                puttanaMuoreConProtetto = protettoPuttana;
            } else if(protettoPuttana === vittimaLupi){
                puttanaSalva = true;
            }
        }

        // --- Suicida ---
        var suicidaIdx = trovaIndiceRuolo(s.ruoli, 'suicida');
        if(suicidaIdx !== -1 && !inattivo(suicidaIdx)){
            if(azioni.suicidaAzione === 'finto'){
                s.finteMorto[suicidaIdx] = true;
            } else if(azioni.suicidaAzione === 'resuscita'){
                s.finteMorto[suicidaIdx] = false;
                s.ruoli[suicidaIdx] = 'contadino';
                eventi.push({ tipo: 'suicida_resuscitato', giocatoreIdx: suicidaIdx });
            }
        }
        // Se i lupi lo colpiscono mentre sta fingendosi morto, l'attacco
        // "coincide" col suo finto suicidio e non ha effetto reale.
        var suicidaAssorbeAttacco = suicidaIdx !== -1 && vittimaLupi === suicidaIdx && s.finteMorto[suicidaIdx];

        // --- Applica (o non applica) la morte per mano dei lupi ---
        if(vittimaLupi !== null && !guardiaSalva && !puttanaSalva && !suicidaAssorbeAttacco){
            registraMorte(vittimaLupi, 'lupi');
        }
        if(puttanaMuoreConProtetto !== null){
            registraMorte(puttanaIdx, 'lupi');
            registraMorte(puttanaMuoreConProtetto, 'lupi');
        }

        // L'esito pubblico del Suicida che finge: appare morto pur essendo
        // vivo. Non passa da registraMorte/nottePacifica: non è una morte
        // reale, è una finzione decisa da lui — resta valida comunque.
        if(suicidaIdx !== -1 && s.finteMorto[suicidaIdx] && s.vivo[suicidaIdx]){
            morti.push({ giocatoreIdx: suicidaIdx, causa: 'suicidio_finto' });
        }

        // --- Medium ---
        var mediumIdx = trovaIndiceRuolo(s.ruoli, 'medium');
        if(mediumIdx !== -1 && !inattivo(mediumIdx) && azioni.mediumBersaglioIdx !== mediumIdx &&
           azioni.mediumBersaglioIdx !== null && azioni.mediumBersaglioIdx !== undefined){
            var bersaglioM = azioni.mediumBersaglioIdx;
            var esitoM = allineamentoVisibile(s.ruoli[bersaglioM], roles);
            // Come per la Veggente: se è il MEDIUM (non il morto osservato)
            // il bersaglio dello Spaccino, è la sua percezione a invertirsi
            // (il Matto non è su un asse buono/cattivo, resta invariato).
            if(esitoM === 'buono' || esitoM === 'cattivo'){
                esitoM = conInversione(esitoM === 'cattivo', mediumIdx) ? 'cattivo' : 'buono';
            }
            rivelazioni.medium = { bersaglioIdx: bersaglioM, esito: esitoM };
        }

        // --- SenzaVolto ---
        // Può provare a resuscitare solo chi è morto "di recente": la notte
        // appena trascorsa o il giorno appena trascorso, prima di quella in
        // corso (mortiFinestraPrecedente, salvata a inizio funzione) — MAI
        // chi muore stanotte stessa (quello lo si saprebbe solo a notte
        // conclusa, non mentre si sceglie). E solo se era Lupo o Contadino.
        var senzaVoltoIdx = trovaIndiceRuolo(s.ruoli, 'senzaVolto');
        if(senzaVoltoIdx !== -1 && !inattivo(senzaVoltoIdx) && azioni.senzaVoltoBersaglioIdx !== senzaVoltoIdx &&
           azioni.senzaVoltoBersaglioIdx !== null && azioni.senzaVoltoBersaglioIdx !== undefined){
            var bersaglioSV = conRedirect(senzaVoltoIdx, azioni.senzaVoltoBersaglioIdx);
            var eraAppenaMorto = mortiFinestraPrecedente.indexOf(bersaglioSV) !== -1;
            var ruoloEligibile = s.ruoli[bersaglioSV] === 'contadino' || s.ruoli[bersaglioSV] === 'lupo';
            if(eraAppenaMorto && ruoloEligibile){
                s.vivo[bersaglioSV] = true;
                eventi.push({ tipo: 'senzavolto_resuscita', giocatoreIdx: bersaglioSV });
                // Vince alla terza persona DISTINTA resuscitata, non alla
                // terza resurrezione in assoluto: se muore di nuovo e viene
                // resuscitata un'altra volta, non conta una seconda volta.
                if(s.senzaVoltoResuscitati.indexOf(bersaglioSV) === -1){
                    s.senzaVoltoResuscitati.push(bersaglioSV);
                }
                if(s.senzaVoltoResuscitati.length >= 3){
                    vittoriaAutomatica = { tipo: 'senzaVolto', giocatoreIdx: senzaVoltoIdx };
                }
            }
        }

        // --- Fantasma ---
        var fantasmaIdx = trovaIndiceRuolo(s.ruoli, 'fantasma');
        if(fantasmaIdx !== -1 && !inattivo(fantasmaIdx)){
            if(azioni.fantasmaBersaglioIdx !== fantasmaIdx &&
               azioni.fantasmaBersaglioIdx !== null && azioni.fantasmaBersaglioIdx !== undefined){
                var bersaglioF = conRedirect(fantasmaIdx, azioni.fantasmaBersaglioIdx);
                if(bersaglioF === s.fantasmaTargetIdx){
                    s.fantasmaStreak++;
                } else {
                    s.fantasmaTargetIdx = bersaglioF;
                    s.fantasmaStreak = 1;
                }
                if(s.fantasmaStreak >= 5 && vittoriaAutomatica === null){
                    vittoriaAutomatica = { tipo: 'fantasma', giocatoreIdx: fantasmaIdx };
                }
                if(bersaglioF === veggenteIdx){
                    registraMorte(fantasmaIdx, 'veggente');
                }
            }
            // Il caso "la Veggente indica il Fantasma" è già gestito sopra,
            // nel blocco della Veggente (stesso registraMorte usato per
            // SenzaVolto/CricetoMannaro): non va ripetuto qui, altrimenti è
            // una seconda chiamata a vuoto quando va tutto liscio (il primo
            // registraMorte segna già il Fantasma come morto) ma diventa un
            // vero doppio-conteggio quando la prima morte viene deviata
            // sull'Angelo (il Fantasma risulta ancora vivo dopo il primo
            // redirect, quindi la guardia "già morto" di registraMorte non
            // la blocca, e questa seconda chiamata lo ucciderebbe per
            // davvero senza che l'Angelo possa intervenire una seconda volta).
        }

        s.notte++;
        return {
            stato: s,
            morti: morti,
            rivelazioni: rivelazioni,
            eventi: eventi,
            vittoria: vittoriaAutomatica
        };
    }

    /* ==========================================================
       ESPORTAZIONE
       ========================================================== */
    return {
        shuffleArray: shuffleArray,
        componiRuoliPartita: componiRuoliPartita,
        etichettaSveglia: etichettaSveglia,
        mortoStorico: mortoStorico,
        ruoloSvegliaStanotte: ruoloSvegliaStanotte,
        calcolaListaNotte: calcolaListaNotte,
        generaIdRuolo: generaIdRuolo,
        descrizioneEffettiva: descrizioneEffettiva,
        trovaIndiceRuolo: trovaIndiceRuolo,
        trovaIndiciRuolo: trovaIndiciRuolo,
        allineamentoVisibile: allineamentoVisibile,
        creaStatoPartita: creaStatoPartita,
        applicaMorte: applicaMorte,
        programmaMorte: programmaMorte,
        risolviVotoLupi: risolviVotoLupi,
        risolviVotoLupiConScadenza: risolviVotoLupiConScadenza,
        calcolaVittoriaSquadre: calcolaVittoriaSquadre,
        vittoriaFinale: vittoriaFinale,
        verificaRuoloReale: verificaRuoloReale,
        interrogaInquisitore: interrogaInquisitore,
        risolviNotte: risolviNotte
    };
});
