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
     * lupo/contadino) a partire da quali ruoli sono selezionati.
     * @param {string[]} ordineRuoli - gli id dei ruoli, nell'ordine della griglia
     * @param {Object.<string,boolean>} selezionati - mappa id -> selezionato o no
     * @param {{lupi:number, contadini:number}} conteggi
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
        descrizioneEffettiva: descrizioneEffettiva
    };
});
