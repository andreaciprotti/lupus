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
 *   giocatori: {
 *     "<playerId>": { nome: "Marco", ruoloId: null, joinedAt: <timestamp> },
 *     ...
 *   }
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

    // Crea una nuova stanza vuota, in attesa di giocatori. Risolve col codice creato.
    function creaStanza(ng){
        return new Promise(function(resolve, reject){
            if(!pronto()){ reject(new Error('LupusSync non configurato: vedi il commento vicino a LupusSync.configura() in index.html.')); return; }
            var codice = generaCodiceStanza();
            db.ref('stanze/' + codice).set({
                creata: firebase.database.ServerValue.TIMESTAMP,
                ng: ng,
                fase: 'lobby',
                giocatori: {}
            }).then(function(){ resolve(codice); }).catch(reject);
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
                    resolve({ playerId: nuovoRif.key, codice: codice });
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
        eliminaStanza: eliminaStanza
    };
});