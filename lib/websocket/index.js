const WebSocket = require('ws');
const Emitter = require('events');
const randomSeed = require('random-seed');
const { DiscordMessage } = require('../../proto/discord-message_pb');
const logger = require('../logging/logger-factory').getLogger('websocket');

class Client extends Emitter {
  constructor(ws, svcs, server) {
    super();
    this.socket = ws;
    this.user = null;
    this.services = svcs;
    this.name = null;
    this.server = server;
    this.handlers = {};
  }

  setUser(user) {
    let initializing = false;
    if (this.user === null) {
      initializing = true;
    }

    this.user = user;

    this.name = this.user.displayName || this.user.DisplayName;

    if (initializing) {
      this.emit('initialized');
    }
  }

  op(event, cb) {
    if (this.handlers[event]) {
      throw new Error('Cannot re-register handler');
    }
    this.handlers[event] = cb;
  }

  async handleMessage(event, msg) {
    const handler = this.handlers[event];

    if (!handler) {
      return false;
    }

    const result = handler.call(this, msg);

    if (result && result.then) {
      await result;
    }

    return true;
  }

  broadcast(event, obj) {
    this.server.clients.forEach((client) => {
      if (client.sock.name !== this.name) {
        client.sock.send(event, obj);
      }
    });
  }

  getOtherUsers() {
    const sockets = [];
    this.server.clients.forEach((client) => {
      if (client.sock.name !== this.name) {
        sockets.push(client.sock);
      }
    });
    return sockets;
  }

  send(event, obj) {
    this.socket.send(JSON.stringify({
      event,
      ...obj,
    }));
  }

  toString() {
    return this.name;
  }
}

module.exports.handleWebsockets = function createServer(globalConfig, server, svcs, onConnection) {
  const wss = new WebSocket.Server({ server });

  // When connections come in, track
  wss.on('connection', (ws) => {
    let clientLogger = logger.child({ component: 'websocket' });
    const sock = new Client(ws, svcs, wss);

    sock.on('error', (e) => {
      clientLogger.error(e, 'Error in client');
    });

    // eslint-disable-next-line no-param-reassign
    ws.sock = sock;

    sock.once('initialized', () => {
      let foundUser = 0;
      sock.server.clients.forEach((client) => {
        if (client.sock.name === sock.name) {
          foundUser += 1;
        }
      });

      clientLogger = clientLogger.child({ user: sock.name });

      if (foundUser > 1) {
        // sock.send('disconnect', { message: 'You are already connected' });
        // ws.terminate();
        // return;
        clientLogger.info('User connected but they are already connected');
      }

      sock.send('loggedIn', { user: sock.name });
      sock.broadcast('userLogIn', { user: sock.name });

      onConnection(sock);
    });

    ws.on('message', async (message) => {
      if (message === 'ping') {
        ws.send('pong');
        return;
      }

      if (!message) {
        return;
      }

      try {
        const msg = JSON.parse(message);
        clientLogger.info({ message }, 'Received new deserializable message from user');
        const { op } = msg;

        if (!op) {
          sock.emit('deserializationError', null, msg);
          return;
        }

        delete msg.op;

        clientLogger.info({ op }, 'Received new websocket message');

        const result = await sock.handleMessage(op, msg);

        if (!result) {
          clientLogger.info({ op }, 'No registered handler for op');
        }
      } catch (e) {
        sock.emit('deserializationError', e);
        clientLogger.error(e, `Deserialization error handling message: ${message}`);
        ws.terminate();
      }
    });

    ws.on('close', (code) => {
      sock.emit('close');
      clientLogger.info({ code }, 'Close socket initiated by user');
    });

    // Special top level handlers
    sock.op('auth', async ({ jwt }) => {
      if (!jwt) {
        clientLogger.warn('User provided an unset valid JWT');
        return;
      }

      clientLogger.info('User trying to log in with JWT...');
      const decoded = svcs.discord.decodeJwt(jwt);
      const user = await svcs.dynamo.getUserFromToken(decoded.token);
      try {
        sock.setUser(user);
      } catch (e) {
        clientLogger.error(e, 'Error trying to log in with JWT');
      }
    });

    sock.op('fakeAuth', ({ name }) => {
      clientLogger.info({ name }, 'User trying to log in...');
      sock.setUser({ DisplayName: name });
    });
  });

  return wss;
};

function createCell(text) {
  return { text, isChecked: false };
}

function getInitialCardState(config, username) {
  const gen = randomSeed.create(config.seed.prefix + username);
  const bingoCard = [];

  const availableCellText = JSON.parse(JSON.stringify(config.bingo));

  for (let i = 0; i < 4; i += 1) {
    bingoCard[i] = [];
    for (let ii = 0; ii < 4; ii += 1) {
      const nextIndex = gen(availableCellText.length);
      const cellText = availableCellText.splice(nextIndex, 1);
      let cell = cellText ? createCell(cellText) : null;
      if (!cell) {
        cell = createCell('');
        cell.isChecked = true;
      }
      bingoCard[i][ii] = cell;
    }
  }

  return bingoCard;
}

module.exports.bindHandlers = function bindHandlers(config, sock, services) {
  const bingoCard = getInitialCardState(config, sock.name);

  // eslint-disable-next-line no-param-reassign
  sock.bingoCard = bingoCard;

  sock.op('getUsers', () => {
    const users = sock.getOtherUsers().map(otherSock => (
      { user: otherSock.name, card: otherSock.bingoCard }
    ));
    sock.send('connectedUsers', { users });
  });

  sock.op('getCardState', () => {
    sock.send('cardStateUpdate', { user: sock.name, bingoCard });
  });

  sock.op('updateCardState', (msg) => {
    const { col, row, isChecked } = msg;

    try {
      bingoCard[col][row].isChecked = isChecked;
    } catch (e) {
      // Do nothing
    }
    sock.broadcast('cardStateUpdate', { user: sock.name, bingoCard });
  });

  sock.op('declareBingo', async (bingo) => {
    const { cells } = bingo;

    const message = new DiscordMessage();
    message.setChannel('259438654890573839');
    message.setPayload(`${sock.name} GOT A BINGO!!!`);

    const bytes = message.serializeBinary();
    const str = Buffer.from(bytes).toString('base64');

    await services.sqs.send({ body: str });
    sock.broadcast('bingoWinner', { user: sock.name, cells });
  });
};
