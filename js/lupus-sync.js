/**
 * LupusSync — l'unico file che parla con "l'esterno" per la modalità a distanza.
 *
 * Principio guida: ogni altra parte del sito chiama SOLO le funzioni qui sotto
 * (creaStanza, entraStanza, ascolta, ...) e non sa né le importa come sono
 * implementate. Oggi sono implementate con Firebase Realtime Database (gratis,
 * zero server da gestire). Il giorno in cui costruirai un vero backend, dovrai
 * riscrivere SOLO l'interno di questo file (le chiamate diventeranno fetch()
 * o WebSocket verso il tuo server) — tutte le funzioni chiamanti, nel resto
 * del sito, resteranno identiche.
 *
 * ATTENZIONE — sicurezza: questa implementazione è VOLUTAMENTE senza controlli
 * di sicurezza (come richiesto): chiunque conosca il codice di una stanza può
 * leggerne e modificarne lo stato. Va bene per questa fase di sviluppo, ma
 * andrà sostituita quando la modalità a distanza diventerà "vera".
 *
 * Forma dei dati di una stanza (in stanze/{codice}):
 * {
 *   creata: <timestamp>,
 *   ng: <numero massimo di giocatori previsto dal narratore>,
 *   fase: 'lobby' | 'ruoli' | 'in_corso',
 *   narratoreAutomatico: <bool>,        // impostata alla creazione, non cambia più
 *   narratorePlayerId: <string|null>,   // se narratoreAutomatico, chi tra i giocatori è il narratore
 *   giocatori: {
 *     "<playerId>": { nome: "Marco", ruoloId: null, joinedAt: <timestamp>, narratore: <bool, opzionale> },
 *     ...
 *   },
 *
 *   // Solo con narratore automatico, ricreato da zero ad ogni notte:
 *   notte: {
 *     numero: 1,
 *     turno: '<ruoloId>' | 'lupi' | null,   // chi sta agendo ora (per mostrare/nascondere le schermate)
 *     scadenzaTurno: <timestamp epoch ms>|null,
 *     azioni: { "<ruoloId>": { valore: <bersaglioPlayerId o altro>, ts: <timestamp> } },
 *     votiLupi: { "<playerId>": { bersaglioPlayerId: <string>, ts: <timestamp> } },
 *     chatLupi: { "<msgId>": { playerId: <string>, testo: <string>, ts: <timestamp> } },
 *     esiti: null | { morti, eventi, vittoria, rivelazioniPrivate: { "<playerId>": {...} } }
 *   },
 *
 *   // Pubblico: chi è vivo/morto adesso e perché — è la fotografia "ufficiale"
 *   // che anche il pannello del narratore-proxy può leggere (mai i privati sopra).
 *   statoPubblico: { vivo: { "<playerId>": <bool> }, morti: [...], notte: <numero> },
 *
 *   // Bottone "Rivelati" di Cacciatore/Inquisitore: eventi verificati dal
 *   // dispositivo del narratore prima di essere pubblicati, così nessuno
 *   // deve fidarsi sulla parola di chi dichiara un ruolo.
 *   rivelazioniPubbliche: { "<eventoId>": { playerId, ruolo, bersaglioPlayerId, tipo, ts } },
 *
 *   // Coda di richieste in attesa che il narratore le verifichi e le
 *   // trasformi (o no) in una rivelazionePubblica: bottone "Rivelati" di
 *   // Cacciatore/Inquisitore, esito del suo interrogatorio.
 *   richiesteSpeciali: { "<id>": { playerId, ruoloAtteso, tipo, bersaglioPlayerId, ts } }
 * }
 */
(function(root, factory){
    if(typeof module !== 'undefined' && module.exports){
        module.exports = factory();
    } else {
        root.LupusSync = factory();
    }
})(typeof self !== 'undefined' ? self : this, function(){
    'use strict';

    var db = null;

    // Va chiamata una volta sola, con la configurazione del tuo progetto Firebase.
    function configura(config){
        if(typeof firebase === 'undefined'){
            console.error('LupusSync: SDK di Firebase non caricato. Controlla gli script in index.html.');
            return;
        }
        if(!firebase.apps.length){
            firebase.initializeApp(config);
        }
        db = firebase.database();
    }

    function pronto(){
        return db !== null;
    }

    // Codice leggibile a voce alta: niente caratteri ambigui (0/O, 1/I/L).
    function generaCodiceStanza(){
        var alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        var codice = '';
        for(var i = 0; i < 5; i++){
            codice += alfabeto[Math.floor(Math.random() * alfabeto.length)];
        }
        return codice;
    }

    // Crea una nuova stanza vuota, in attesa di giocatori. Risolve col codice
    // creato (stringa) — o, se opzioni.narratoreAutomatico è vero, con
    // { codice, narratorePlayerId }: in quel caso il narratore viene inserito
    // subito come giocatore (con opzioni.nomeNarratore) e riceverà un ruolo
    // come chiunque altro al momento della distribuzione.
    function creaStanza(ng, opzioni){
        opzioni = opzioni || {};
        return new Promise(function(resolve, reject){
            if(!pronto()){ reject(new Error('LupusSync non configurato: vedi il commento vicino a LupusSync.configura() in index.html.')); return; }
            var codice = generaCodiceStanza();
            var rifStanza = db.ref('stanze/' + codice);
            var giocatoriIniziali = {};
            var narratorePlayerId = null;

            if(opzioni.narratoreAutomatico){
                var rifNarratore = rifStanza.child('giocatori').push();
                narratorePlayerId = rifNarratore.key;
                giocatoriIniziali[narratorePlayerId] = {
                    nome: opzioni.nomeNarratore || 'Narratore',
                    ruoloId: null,
                    joinedAt: firebase.database.ServerValue.TIMESTAMP,
                    narratore: true
                };
            }

            rifStanza.set({
                creata: firebase.database.ServerValue.TIMESTAMP,
                ng: ng,
                fase: 'lobby',
                narratoreAutomatico: !!opzioni.narratoreAutomatico,
                narratorePlayerId: narratorePlayerId,
                giocatori: giocatoriIniziali
            }).then(function(){
                resolve(opzioni.narratoreAutomatico ? { codice: codice, narratorePlayerId: narratorePlayerId } : codice);
            }).catch(reject);
        });
    }

    // Un giocatore entra in una stanza esistente. Risolve con { playerId, codice }.
    function entraStanza(codice, nome){
        return new Promise(function(resolve, reject){
            if(!pronto()){ reject(new Error('LupusSync non configurato.')); return; }
            var rifStanza = db.ref('stanze/' + codice);
            rifStanza.once('value').then(function(snap){
                var stato = snap.val();
                if(!stato){ reject(new Error('Codice partita non trovato. Controlla di averlo scritto giusto.')); return; }
                if(stato.fase !== 'lobby'){ reject(new Error('Questa partita è già iniziata: non puoi più entrare.')); return; }
                var numeroAttuali = stato.giocatori ? Object.keys(stato.giocatori).length : 0;
                if(numeroAttuali >= stato.ng){ reject(new Error('La stanza è già al completo.')); return; }

                var nuovoRif = rifStanza.child('giocatori').push();
                nuovoRif.set({
                    nome: nome,
                    ruoloId: null,
                    joinedAt: firebase.database.ServerValue.TIMESTAMP
                }).then(function(){
                    resolve({ playerId: nuovoRif.key, codice: codice, narratoreAutomatico: !!stato.narratoreAutomatico });
                }).catch(reject);
            }).catch(reject);
        });
    }

    // Il narratore rimuove un giocatore indesiderato dalla lobby.
    function rimuoviGiocatore(codice, playerId){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/giocatori/' + playerId).remove();
    }

    function impostaFase(codice, fase){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/fase').set(fase);
    }

    // Scrive il ruolo assegnato a ciascun giocatore e porta la stanza in fase "in_corso".
    // mappaGiocatoreRuolo: { playerId: idRuolo, ... }
    function assegnaRuoli(codice, mappaGiocatoreRuolo){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        var aggiornamenti = {};
        Object.keys(mappaGiocatoreRuolo).forEach(function(playerId){
            aggiornamenti['giocatori/' + playerId + '/ruoloId'] = mappaGiocatoreRuolo[playerId];
        });
        aggiornamenti['fase'] = 'in_corso';
        return db.ref('stanze/' + codice).update(aggiornamenti);
    }

    // Ascolta i cambiamenti di una stanza in tempo reale. callback(stato) viene
    // chiamata subito con lo stato attuale, poi ogni volta che cambia qualcosa.
    // Restituisce una funzione da chiamare per smettere di ascoltare.
    function ascolta(codice, callback){
        if(!pronto()){ console.error('LupusSync non configurato.'); return function(){}; }
        var rif = db.ref('stanze/' + codice);
        var handler = function(snap){ callback(snap.val()); };
        rif.on('value', handler);
        return function smettiAscolto(){ rif.off('value', handler); };
    }

    // Cancella completamente una stanza (es. il narratore annulla la partita).
    function eliminaStanza(codice){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice).remove();
    }

    // Il narratore può cambiare il numero di posti mentre è ancora in lobby.
    function impostaNumeroGiocatori(codice, ng){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/ng').set(ng);
    }

    /* ==========================================================
       NARRATORE AUTOMATICO — solo la parte "trasporto": nessuna delle
       funzioni qui sotto decide chi vince o chi muore, si limitano a
       leggere/scrivere i rami giusti. La logica vive tutta in
       LupusEngine; qui sotto arriva già risolta da chi chiama (oggi, il
       dispositivo del narratore).
       ========================================================== */

    // Azzera/avvia il nodo "notte" per la notte indicata, già pronto per il
    // primo turno (un'unica scrittura atomica: chi ascolta non vede mai un
    // turno nullo di passaggio prima del vero primo turno).
    function avviaNotte(codice, numero, primoRuolo, scadenzaTurno){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/notte').set({
            numero: numero,
            turno: primoRuolo || null,
            scadenzaTurno: scadenzaTurno || null,
            azioni: {},
            votiLupi: {},
            chatLupi: {},
            esiti: null
        });
    }

    // Fa avanzare il turno (quale ruolo/i lupi stanno agendo ora), con
    // un'eventuale scadenza (epoch ms) che la UI usa per il countdown locale.
    function impostaTurnoNotte(codice, ruoloId, scadenzaTs){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/notte').update({
            turno: ruoloId || null,
            scadenzaTurno: scadenzaTs || null
        });
    }

    // Un giocatore sottomette la propria azione per il ruolo che interpreta
    // stanotte (bersaglio, o altro valore specifico del ruolo: es. l'azione
    // del Suicida è 'finto'/'resuscita', quella del Neomelodico è un bool).
    function sottomettiAzioneNotte(codice, ruoloId, valore){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/notte/azioni/' + ruoloId).set({
            valore: valore,
            ts: firebase.database.ServerValue.TIMESTAMP
        });
    }

    // Un lupo vota (o cambia voto) durante la fase di consenso. Ogni voto
    // sovrascrive il precedente dello stesso giocatore: chi ascolta vede
    // sempre lo stato attuale dei voti, in tempo reale.
    function votaLupi(codice, playerId, bersaglioPlayerId){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/notte/votiLupi/' + playerId).set({
            bersaglioPlayerId: bersaglioPlayerId,
            ts: firebase.database.ServerValue.TIMESTAMP
        });
    }

    // Messaggio nella chat privata tra i soli Lupi (append-only).
    function inviaMessaggioLupi(codice, playerId, testo){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/notte/chatLupi').push({
            playerId: playerId,
            testo: testo,
            ts: firebase.database.ServerValue.TIMESTAMP
        });
    }

    // Il narratore (dopo aver girato LupusEngine.risolviNotte lato suo)
    // scrive qui il risultato: pubblico E privato per-giocatore restano
    // sotto lo stesso nodo "notte", ma è compito della UI non mostrare mai
    // i privati di qualcun altro sullo schermo del narratore.
    function scriviEsitiNotte(codice, esiti){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/notte/esiti').set(esiti);
    }

    // Aggiorna il ruolo "attuale" di un giocatore (Mitomane che si
    // converte, Suicida che resuscita da contadino, ...): sovrascrive
    // ruoloId, che resta comunque l'unica fonte di verità sul ruolo.
    function aggiornaRuoloGiocatore(codice, playerId, nuovoRuoloId){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/giocatori/' + playerId + '/ruoloId').set(nuovoRuoloId);
    }

    // Fotografia pubblica e ufficiale di chi è vivo/morto — l'unica cosa
    // che il pannello di supervisione del narratore-proxy può leggere.
    function scriviStatoPubblico(codice, statoPubblico){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/statoPubblico').set(statoPubblico);
    }

    // Ascolta l'intero nodo "notte" (turno, azioni, voti, chat, esiti) in
    // tempo reale. Restituisce una funzione per smettere di ascoltare.
    function ascoltaNotte(codice, callback){
        if(!pronto()){ console.error('LupusSync non configurato.'); return function(){}; }
        var rif = db.ref('stanze/' + codice + '/notte');
        var handler = function(snap){ callback(snap.val()); };
        rif.on('value', handler);
        return function smettiAscolto(){ rif.off('value', handler); };
    }

    // Ascolta la fotografia pubblica (vivo/morto).
    function ascoltaStatoPubblico(codice, callback){
        if(!pronto()){ console.error('LupusSync non configurato.'); return function(){}; }
        var rif = db.ref('stanze/' + codice + '/statoPubblico');
        var handler = function(snap){ callback(snap.val()); };
        rif.on('value', handler);
        return function smettiAscolto(){ rif.off('value', handler); };
    }

    // Pubblica un evento di rivelazione verificato (bottone "Rivelati" di
    // Cacciatore/Inquisitore) — va chiamata SOLO dopo aver controllato con
    // LupusEngine.verificaRuoloReale che chi lo dichiara lo sia davvero.
    // evento: { playerId, ruolo, bersaglioPlayerId, tipo }.
    function pubblicaRivelazione(codice, evento){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        var dati = {
            playerId: evento.playerId,
            ruolo: evento.ruolo,
            bersaglioPlayerId: evento.bersaglioPlayerId || null,
            tipo: evento.tipo,
            ts: firebase.database.ServerValue.TIMESTAMP
        };
        // Campo extra usato solo dall'esito pubblico dell'Inquisitore (il
        // bersaglio ha risposto o no) — opzionale per tutti gli altri eventi.
        if(evento.rispose !== undefined) dati.rispose = !!evento.rispose;
        return db.ref('stanze/' + codice + '/rivelazioniPubbliche').push(dati);
    }

    // Ascolta le rivelazioni pubbliche (Cacciatore/Inquisitore che si svelano).
    function ascoltaRivelazioni(codice, callback){
        if(!pronto()){ console.error('LupusSync non configurato.'); return function(){}; }
        var rif = db.ref('stanze/' + codice + '/rivelazioniPubbliche');
        var handler = function(snap){ callback(snap.val() || {}); };
        rif.on('value', handler);
        return function smettiAscolto(){ rif.off('value', handler); };
    }

    // Richiesta di un'azione speciale diurna (bottone "Rivelati" del
    // Cacciatore/Inquisitore, o l'esito del suo interrogatorio): il
    // dispositivo del narratore la verifica contro il ruolo reale prima di
    // pubblicarla come rivelazione ufficiale — chi chiama qui non deve
    // fidarsi di sé stesso, è solo una richiesta in attesa di verifica.
    function richiediAzioneSpeciale(codice, richiesta){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        var dati = {};
        Object.keys(richiesta).forEach(function(k){ dati[k] = richiesta[k]; });
        dati.ts = firebase.database.ServerValue.TIMESTAMP;
        return db.ref('stanze/' + codice + '/richiesteSpeciali').push(dati);
    }

    // Il narratore ascolta solo le richieste NUOVE (child_added), le elabora
    // una alla volta e poi le rimuove con rimuoviRichiestaSpeciale.
    function ascoltaRichiesteSpeciali(codice, callback){
        if(!pronto()){ console.error('LupusSync non configurato.'); return function(){}; }
        var rif = db.ref('stanze/' + codice + '/richiesteSpeciali');
        var handler = function(snap){
            var val = snap.val() || {};
            val.id = snap.key;
            callback(val);
        };
        rif.on('child_added', handler);
        return function smettiAscolto(){ rif.off('child_added', handler); };
    }

    function rimuoviRichiestaSpeciale(codice, id){
        if(!pronto()) return Promise.reject(new Error('LupusSync non configurato.'));
        return db.ref('stanze/' + codice + '/richiesteSpeciali/' + id).remove();
    }

    /* ==========================================================
       STATISTICHE — non passano più da Firebase: vanno a un piccolo
       server proprio (server/server.js, su una VM Oracle) che le salva in
       SQLite e le mostra in una pagina protetta da password. Funziona
       anche per le partite in presenza, che altrimenti non toccherebbero
       mai la rete. Una partita = una riga con id, modalita ('presenza' |
       'distanza'), numGiocatori, inizio, stato ('in corso' | 'conclusa' |
       'interrotta'), checkpoint (es. "notte 3"), ultimoAggiornamento,
       esito e fine: i timestamp li mette il SERVER, non il dispositivo.
       Tutte queste funzioni sono "spara e dimentica": se il server non
       risponde, o il dispositivo è offline, non scrivono nulla e non
       devono MAI poter bloccare o far fallire una partita vera — quella
       in presenza, in particolare, deve restare giocabile anche offline.
       Chi le chiama può comunque aspettare la promise restituita (usata
       prima di un ricaricamento della pagina), che si risolve sempre entro
       pochi secondi, anche se la rete non risponde.
       ========================================================== */

    var URL_STATISTICHE = 'https://api.lupusonline.it';
    var ATTESA_MASSIMA_STATISTICHE_MS = 3000;

    // Id unico per ogni partita (in presenza o a distanza): niente più
    // dipendenza da Firebase né dal codice stanza, che si può riusare.
    function nuovoIdPartita(){
        var alfabeto = 'abcdefghijklmnopqrstuvwxyz0123456789';
        var casuale = '';
        for(var i = 0; i < 6; i++){
            casuale += alfabeto.charAt(Math.floor(Math.random() * alfabeto.length));
        }
        return 'p' + Date.now().toString(36) + casuale;
    }

    // Content-Type text/plain: è una richiesta "semplice" per il browser,
    // quindi niente richiesta preliminare (preflight) a ogni evento.
    function inviaEventoStatistiche(dati){
        if(typeof fetch === 'undefined') return Promise.resolve();
        var richiesta = fetch(URL_STATISTICHE + '/evento', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(dati),
            keepalive: true
        }).then(function(){}, function(){});
        var scadenza = new Promise(function(resolve){ setTimeout(resolve, ATTESA_MASSIMA_STATISTICHE_MS); });
        return Promise.race([richiesta, scadenza]);
    }

    function registraPartitaIniziata(idPartita, dati){
        if(!idPartita) return Promise.resolve();
        return inviaEventoStatistiche({
            id: idPartita, evento: 'iniziata', modalita: dati.modalita, numGiocatori: dati.numGiocatori
        });
    }

    // Richiamata ad ogni avanzamento rilevante (nuova notte, giorno dopo
    // una notte risolta): NON segna una conclusione, serve solo a sapere
    // dove si trovava una partita se poi risultasse abbandonata.
    function aggiornaCheckpointPartita(idPartita, checkpoint){
        if(!idPartita) return Promise.resolve();
        return inviaEventoStatistiche({ id: idPartita, evento: 'checkpoint', checkpoint: checkpoint });
    }

    function registraPartitaConclusa(idPartita, esito){
        if(!idPartita) return Promise.resolve();
        return inviaEventoStatistiche({ id: idPartita, evento: 'conclusa', esito: esito });
    }

    function registraPartitaInterrotta(idPartita, checkpoint){
        if(!idPartita) return Promise.resolve();
        return inviaEventoStatistiche({ id: idPartita, evento: 'interrotta', checkpoint: checkpoint });
    }

    /* ----------------------------------------------------------
       Pareri degli utenti: a differenza delle statistiche, qui chi
       chiama deve sapere se l'invio è andato a buon fine (per dirlo
       all'utente). Restituisce sempre una promise che si risolve (mai
       rifiuta) con { ok, stato }: stato 0 = rete assente o troppo lenta.
       ---------------------------------------------------------- */
    var ATTESA_MASSIMA_FEEDBACK_MS = 10000;
    function inviaFeedback(dati){
        if(typeof fetch === 'undefined') return Promise.resolve({ ok: false, stato: 0 });
        var richiesta = fetch(URL_STATISTICHE + '/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(dati)
        }).then(function(r){ return { ok: r.ok, stato: r.status }; },
                function(){ return { ok: false, stato: 0 }; });
        var scadenza = new Promise(function(resolve){
            setTimeout(function(){ resolve({ ok: false, stato: 0 }); }, ATTESA_MASSIMA_FEEDBACK_MS);
        });
        return Promise.race([richiesta, scadenza]);
    }

    return {
        configura: configura,
        generaCodiceStanza: generaCodiceStanza,
        creaStanza: creaStanza,
        entraStanza: entraStanza,
        rimuoviGiocatore: rimuoviGiocatore,
        impostaFase: impostaFase,
        impostaNumeroGiocatori: impostaNumeroGiocatori,
        assegnaRuoli: assegnaRuoli,
        ascolta: ascolta,
        eliminaStanza: eliminaStanza,
        avviaNotte: avviaNotte,
        impostaTurnoNotte: impostaTurnoNotte,
        sottomettiAzioneNotte: sottomettiAzioneNotte,
        votaLupi: votaLupi,
        inviaMessaggioLupi: inviaMessaggioLupi,
        scriviEsitiNotte: scriviEsitiNotte,
        aggiornaRuoloGiocatore: aggiornaRuoloGiocatore,
        scriviStatoPubblico: scriviStatoPubblico,
        ascoltaNotte: ascoltaNotte,
        ascoltaStatoPubblico: ascoltaStatoPubblico,
        pubblicaRivelazione: pubblicaRivelazione,
        ascoltaRivelazioni: ascoltaRivelazioni,
        richiediAzioneSpeciale: richiediAzioneSpeciale,
        ascoltaRichiesteSpeciali: ascoltaRichiesteSpeciali,
        rimuoviRichiestaSpeciale: rimuoviRichiestaSpeciale,
        nuovoIdPartita: nuovoIdPartita,
        registraPartitaIniziata: registraPartitaIniziata,
        aggiornaCheckpointPartita: aggiornaCheckpointPartita,
        registraPartitaConclusa: registraPartitaConclusa,
        registraPartitaInterrotta: registraPartitaInterrotta,
        inviaFeedback: inviaFeedback
    };
});