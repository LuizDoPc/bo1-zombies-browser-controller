# Rodar localmente com controle

Este fork adiciona `run-local.py` e `Iniciar BO1.command` ao projeto [kpwn/bo1z-mp](https://github.com/kpwn/bo1z-mp). O iniciador serve o jogo somente neste computador, em `127.0.0.1:8000`.

## Requisitos

- Python 3 e Node.js com npm. A instalação local foi feita com Python 3.14 e Node.js 24.
- Chrome com aceleração gráfica e suporte aos recursos exigidos pelo motor.
- Controle conectado por USB ou Bluetooth e reconhecido pelo sistema.
- Espaço livre: a instalação completa descrita abaixo baixa aproximadamente 9,3 GB, além do cache criado pelo navegador.

## Instalação

Na pasta deste repositório, execute:

```sh
python3 tools-fetch-site.py
python3 tools-fetch-packs.py
cd mp
npm ci --ignore-scripts --no-audit --no-fund
cd ..
node mp/build.mjs
python3 run-local.py
```

Os dois primeiros comandos baixam os arquivos distribuídos pelo site original; eles não estão no Git. O script de packs baixa todos os mapas e verifica os hashes. A execução validada neste fork usou somente Kino der Toten. Os patches dependem de uma versão compatível dos arquivos do site; se o build informar `patch no longer applies`, não ignore o erro.

Abra no Chrome: **http://localhost:8000/bo1z/kino**. Selecione **PLAY SOLO** e espere o carregamento e a preparação inicial dos gráficos. Clique para iniciar quando solicitado. Não é necessário configurar serviços de lobby para jogar solo.

No macOS, depois da instalação, também é possível iniciar o servidor com duplo clique em `Iniciar BO1.command`. Mantenha o terminal aberto durante o jogo. Para encerrar o servidor, pressione Ctrl+C. Se a porta 8000 estiver ocupada por uma instância já aberta, use essa instância ou encerre-a antes de iniciar outra.

## Controle

Com a página em foco, pressione um botão do controle para que o navegador o reconheça. O patch original lê `navigator.getGamepads()` e alimenta o suporte a controle do motor.

Layout padrão descrito pelo projeto original:

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

## O que foi verificado

Em 11/10/2026, Kino der Toten chegou à partida no Chrome/macOS. O motor reconheceu um DualShock 4 com mapeamento padrão e recebeu os eixos dos analógicos. Na observação registrada não houve erros de console, exceções de script ou eventos de entrada descartados. Sensação da mira, todos os botões, outros mapas e multiplayer ainda exigem testes específicos.

## Créditos e arquivos locais

- Código de controle, patches e ferramentas: [kpwn/bo1z-mp](https://github.com/kpwn/bo1z-mp).
- Versão web utilizada: [vel.gg/bo1z](https://vel.gg/bo1z/).
- Jogo original: Treyarch / Activision.

`site/`, `overlay/`, `static/`, `node_modules`, logs, telemetria e configurações privadas ficam fora do versionamento. Este fork não inclui o jogo nem atribui uma nova licença ao trabalho original. Para detalhes técnicos e implantação, consulte [DEPLOY.md](DEPLOY.md) e a documentação original no README.
