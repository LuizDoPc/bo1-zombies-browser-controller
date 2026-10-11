# BO1 Zombies — abrir e jogar

Kino der Toten no navegador, com controle e cooperativo na mesma rede. Iniciadores para **Windows 64 bits e macOS**, sem instalar Python ou Node manualmente.

## Primeira vez

1. [Baixe o ZIP](https://github.com/LuizDoPc/bo1-zombies-browser-controller/archive/refs/heads/main.zip) e **extraia a pasta inteira** em cada computador. Se você usa Git, também pode clonar este repositório.
2. **Windows:** dê dois cliques em `Jogar.cmd`.
3. **Mac:** dê dois cliques em `Jogar.command`. Pelo Terminal, na pasta extraída, use `bash Jogar.command`.
4. Aguarde a preparação. O Chrome (ou Edge) abre com as opções **Jogar sozinho**, **Criar partida na rede** e **Entrar na partida de um amigo**.

Quem prefere um comando, dentro da pasta:

| Windows (PowerShell) | macOS (Terminal) |
| --- | --- |
| `.\Jogar.cmd` | `bash Jogar.command` |

O primeiro uso precisa de internet e baixa aproximadamente **1 GB de jogo**, além dos componentes do iniciador. Reserve **4 GB livres**, contando o cache do navegador. As próximas aberturas reutilizam a instalação. Mantenha a janela do iniciador aberta durante o jogo.

Use Chrome ou Edge atualizado, com aceleração gráfica. Conecte o controle por USB/Bluetooth e pressione um botão para o navegador reconhecê-lo. A primeira partida também prepara arquivos e gráficos; aguarde.

## Jogar juntos

Os dois precisam instalar e abrir sua própria cópia, na mesma rede Wi-Fi ou por cabo.

1. Um escolhe **Criar partida na rede** e envia o código de convite ao outro.
2. O outro escolhe **Entrar na partida de um amigo**, cola o convite e devolve o código de resposta.
3. Quem criou cola a resposta e aperta **Conectar**.
4. Ambos clicam em **Preparar meu jogo**. Quando estiverem prontos, quem criou clica em **Começar partida**.

O cooperativo é experimental. A troca de códigos conecta os navegadores diretamente por WebRTC; não exige conta, servidor público ou configuração de roteador. Cada navegador abre o jogo no próprio `localhost`. Redes de convidados ou isolamento entre dispositivos podem impedir a conexão.

## Verificação

- Chrome/macOS: Kino carregado e controle DualShock 4 reconhecido, com eixos recebidos pelo motor.
- Duas abas em origens locais distintas: convite, resposta, sala com dois jogadores e ambos dentro da mesma partida de Kino.
- Testes do instalador e verificações automáticas de bootstrap/Node em Windows e Mac: [GitHub Actions](https://github.com/LuizDoPc/bo1-zombies-browser-controller/actions/workflows/launcher.yml).
- Ainda falta testar uma sessão longa entre um Mac e um Windows físicos; isso também depende da GPU, dos drivers e da rede de vocês.

[Ajuda, controles e reparação](docs/LOCAL-PT-BR.md) · [Documentação técnica original](docs/UPSTREAM.md)

## Créditos

Fork de [kpwn/bo1z-mp](https://github.com/kpwn/bo1z-mp), autor dos patches de controle, cooperativo e WebAssembly. Versão web: [vel.gg/bo1z](https://vel.gg/bo1z/). Jogo: Treyarch / Activision.

Este repositório contém código e ferramentas. Os arquivos do jogo são baixados da origem durante a instalação e **não estão publicados neste GitHub**. Componentes, arquivos baixados, logs e configurações privadas ficam fora do Git. Os patches dependem de uma versão compatível do site original; mudanças na origem podem exigir atualização deste projeto.
