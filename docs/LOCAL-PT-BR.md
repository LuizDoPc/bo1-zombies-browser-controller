# Instalação e ajuda

## Abrir o jogo

Baixe e extraia o ZIP do repositório ou clone com Git. No Windows, abra `Jogar.cmd`; no Mac, abra `Jogar.command`. O mesmo arquivo instala na primeira vez e abre nas próximas. Não precisa instalar Python, Node ou npm globalmente.

No Terminal/PowerShell, dentro da pasta:

```powershell
# Windows
.\Jogar.cmd
```

```sh
# Mac
bash Jogar.command
```

No primeiro uso, mantenha a internet conectada. O instalador baixa o motor, somente o pacote de Kino e as ferramentas necessárias; verifica os hashes dos packs e dos arquivos compactados de uv/Node, monta os patches e abre o navegador. Os componentes ficam em `.runtime/`. Downloads de packs já concluídos são reaproveitados após uma interrupção.

Reserve 4 GB livres para instalação e cache. O jogo exige uma GPU/driver compatível com WebGPU e Chrome ou Edge atualizado. A primeira partida também faz uma preparação no navegador; isso demora mais que as próximas.

Mantenha o Terminal aberto enquanto joga. Para fechar o servidor, pressione Ctrl+C. Abrir o iniciador novamente reaproveita o servidor desta instalação. Se a porta 8000 estiver ocupada, ele tenta outra até 8009.

## Cooperativo na rede

Cada computador abre seu próprio iniciador. Não abra o IP do outro computador: recursos do motor e do controle precisam do contexto seguro que o navegador oferece em `localhost`.

1. Conectem os computadores à mesma rede.
2. Um clica em **Criar partida na rede** e copia o convite.
3. O amigo clica em **Entrar na partida de um amigo**, cola o convite e clica em **Entrar**.
4. O amigo devolve o código de resposta. Quem criou cola a resposta e clica em **Conectar**.
5. Ambos clicam em **Preparar meu jogo**. Quando os dois estiverem prontos, o criador clica em **Começar partida**.

Os códigos também podem ser lidos por QR, se o computador tiver câmera. A partida usa WebRTC direto; esta modalidade não usa serviços externos de sinalização, STUN ou TURN. O servidor de arquivos escuta apenas em `127.0.0.1`.

Se a conexão falhar, confira se ambos estão na mesma rede, fora da rede de convidados. Se o Windows pedir acesso do navegador à rede, permita a rede privada usada para jogar. Não é necessário abrir portas no roteador. Recrie o convite se alguém recarregar a página ou fechar a aba durante a conexão.

O projeto original suporta até quatro jogadores, mas este fluxo foi verificado com dois. A partida cooperativa ainda é experimental.

## Controle

Conecte por USB ou Bluetooth, deixe a página em foco e pressione um botão. O patch lê a Gamepad API do navegador e alimenta o controle nativo do motor. No início, use o direcional/analógico esquerdo para escolher e A/Cruz para confirmar. O teclado e o mouse também funcionam.

Layout padrão do projeto original:


| Ação | Xbox | PlayStation |
| --- | --- | --- |
| Andar / olhar | Analógicos esquerdo / direito | Analógicos esquerdo / direito |
| Atirar / mirar | RT / LT | R2 / L2 |
| Pular | A | Cruz |
| Recarregar / usar | X | Quadrado |
| Trocar arma | Y | Triângulo |
| Postura | B | Círculo |
| Correr / corpo a corpo | L3 / R3 | L3 / R3 |
| Pausar | Start | Options |

Teclado e mouse continuam disponíveis. Vibração não está implementada pelo patch original. Para diagnóstico, acrescente `?padlog=1` à URL e consulte o console do Chrome.

## Se não abrir

- Abra `Jogar.cmd`/`Jogar.command` novamente para continuar uma preparação interrompida.
- Se a tela de jogo mostrar erro de GPU, atualize o navegador/driver e verifique se a aceleração gráfica está ativa.
- Para reparar arquivos, encerre primeiro a janela do iniciador e execute `Jogar.cmd --repair` (Windows) ou `bash Jogar.command --repair` (Mac).
- Os detalhes de falhas de download ou montagem ficam em `installation.log`, na pasta do projeto. Não publique esse arquivo automaticamente.
- Um erro `patch no longer applies` significa que a versão da origem mudou e os patches precisam de atualização; não ignore essa falha.

Para atualizar uma cópia clonada, feche o jogo, execute `git pull` e abra o iniciador. Quem baixou ZIP pode extrair a nova versão por cima da mesma pasta, preservando `.runtime/` e `site/`.

## Validação e limites

Em 11/10/2026, o iniciador macOS baixou suas ferramentas locais, verificou os 82 arquivos de Kino e montou o motor. Kino chegou à partida no Chrome; um DualShock 4 foi reconhecido e os eixos chegaram ao motor. Dois clientes locais separados por origem completaram o convite/resposta e entraram na mesma partida, ambos mostrando as duas pontuações.

A automação do GitHub testa o bootstrap, a integridade dos downloads, o lock de instalação e a execução real de Node/npm em caminhos com espaços no Windows e no Mac. Ela não executa o jogo em uma GPU Windows. Partidas longas e a rede entre dois computadores físicos ainda precisam ser validadas.

## Arquivos e créditos

`site/`, `overlay/`, `.runtime/`, `node_modules`, logs e configurações privadas não entram no Git. Código de controle/cooperativo: [kpwn/bo1z-mp](https://github.com/kpwn/bo1z-mp). Versão web: [vel.gg](https://vel.gg/bo1z/). Jogo original: Treyarch / Activision. Este fork não atribui uma nova licença ao trabalho original.

Para detalhes técnicos, consulte [UPSTREAM.md](UPSTREAM.md) e [DEPLOY.md](DEPLOY.md).
