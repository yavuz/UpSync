// Gerçek dünyadaki "boşta kalınca bağlantı ölür" senaryosunu taklit eden
// TCP aracısı. NAT / güvenlik duvarı bir bağlantıyı düşürdüğünde karşı
// taraf FIN göndermez: paketler sessizce kaybolur ve istemcinin soketi
// asla 'close' üretmez. Testteki SFTP sunucusunu doğrudan susturmak bunu
// taklit edemiyor - orada TCP yığını hâlâ canlı olduğu için FIN'e FIN ile
// yanıt veriliyor ve soket düzgünce kapanıyor.
import net from 'net';

export async function startBlackholeProxy(upstreamPort, upstreamHost = '127.0.0.1') {
  const pairs = [];

  const server = net.createServer({ allowHalfOpen: true }, client => {
    const up = net.connect(upstreamPort, upstreamHost);
    const pair = { client, up, dead: false };
    pairs.push(pair);

    client.on('data', d => {
      if (!pair.dead) up.write(d);
    });
    up.on('data', d => {
      if (!pair.dead) client.write(d);
    });

    // Kara deliğe düşmüş bir çiftte FIN de iletilmez: istemcinin soketi
    // FIN_WAIT_2'de asılı kalır, tıpkı düşen bir NAT oturumundaki gibi.
    client.on('end', () => {
      if (!pair.dead) up.end();
    });
    up.on('end', () => {
      if (!pair.dead) client.end();
    });

    const drop = () => {
      if (pair.dead) return;
      client.destroy();
      up.destroy();
    };
    client.on('error', drop);
    up.on('error', drop);
  });

  await new Promise(res => server.listen(0, '127.0.0.1', res));

  return {
    port: server.address().port,
    // Mevcut bağlantıları kara deliğe çevirir; YENİ bağlantılar normal
    // çalışmaya devam eder - sunucu ayakta, sadece eski oturum düştü.
    blackholeExisting() {
      for (const pair of pairs) {
        pair.dead = true;
        pair.up.destroy();
      }
    },
    close() {
      for (const pair of pairs) {
        pair.dead = true;
        pair.client.destroy();
        pair.up.destroy();
      }
      return new Promise(res => server.close(res));
    },
  };
}
