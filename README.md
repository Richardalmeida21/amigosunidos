# Painel de Contas

Aplicativo desktop local que consulta as contas no Supabase e cria um botão para
cada registro. Ao clicar, ele abre uma janela isolada do Chrome ou Edge, aplica
os cookies e os dados de armazenamento daquela conta e navega para a URL da
ferramenta.

Os dados sensíveis ficam no processo principal do aplicativo. A interface recebe
somente nome, ferramenta, status e URL; cookies, senhas e conteúdo de storage não
chegam ao HTML nem são registrados em logs.

## Como iniciar

Requisitos: Windows, Node.js 22.12 ou mais recente e Google Chrome ou Microsoft
Edge instalado.

1. Dê dois cliques em **Iniciar Painel.cmd**.
2. Na primeira execução, aguarde a instalação das dependências.
3. Clique em **Entrar nesta conta**.

Também é possível usar o terminal:

\`\`\`powershell
npm install --include=dev
npm start
\`\`\`

Enquanto o painel estiver aberto, cada conta mantém seu próprio contexto do
navegador. Clicar novamente na mesma conta traz a janela existente para frente.
O botão **Reiniciar acesso** fecha somente o contexto daquela conta, consulta
novamente o bundle no Supabase e reaplica cookies e storage em uma janela nova.
Esse reinício não altera o banco nem renova cookies ou tokens já expirados.
Os cartões mostram a idade de `updated_at`; uma nova consulta pode retornar o
mesmo bundle antigo quando nenhum worker atualizou a linha.
Ao fechar o painel, os contextos são descartados e nenhum perfil com cookies é
salvo em disco.

## Configuração

Para o exemplo atual, o app encontra a URL do projeto e a chave publicável no
comando inicial de \`Exemplo.txt\`. Ele não tenta interpretar a saída formatada
do PowerShell.

Para deixar de depender desse arquivo:

1. Copie \`.env.example\` para \`.env\`.
2. Preencha \`SUPABASE_URL\` e \`SUPABASE_PUBLISHABLE_KEY\`.
3. Defina \`ALLOW_EXAMPLE_CONFIG_FALLBACK=false\`.

Configurações opcionais:

- \`SUPABASE_ACCESS_TOKEN\`: JWT temporário de um usuário autenticado, usado como
  \`Authorization: Bearer\`. O MVP recusa tokens \`service_role\`/anônimos e não
  faz renovação automática; ao expirar, é necessário gerar outro.
- \`SUPABASE_ACCOUNTS_TABLE\`: padrão \`tool_accounts\`.
- \`SUPABASE_TOOLS_RELATION\`: padrão \`tools\`.
- \`ACCOUNT_LIMIT\`: padrão 500, máximo 1000.
- \`BROWSER_CHANNEL\`: \`chrome\`, \`msedge\` ou \`chromium\`.

O relacionamento atual usa os campos \`tools.base_url\` e \`tools.login_url\`
para decidir a página que será aberta. A consulta da lista seleciona somente
metadados. O bundle de sessão de uma conta é consultado apenas no clique.

Toda conta ativa com uma URL HTTPS válida fica disponível para abertura. As
flags de catálogo da ferramenta (oculta, inativa ou em manutenção) e o rótulo
\`login_method\` são informativos e não desabilitam o botão. O app continua
usando apenas cookies e storage; ele não consulta nem preenche senhas.

## Segurança importante

O exemplo fornecido consegue ler cookies, senhas e storage usando somente uma
chave publicável, sem uma sessão de usuário. Isso indica que o papel anônimo tem
acesso aos dados sensíveis. Uma chave publicável identifica o projeto, mas não é
um controle de acesso.

Use o estado atual apenas com dados fictícios. Antes de armazenar contas reais:

- remova o acesso de \`anon\` às tabelas sensíveis;
- habilite Supabase Auth e RLS por proprietário (\`auth.uid() = owner_id\`);
- conceda somente \`SELECT\` ao papel autenticado quando for suficiente;
- nunca coloque uma chave \`service_role\` ou \`sb_secret\` neste aplicativo;
- remova \`Exemplo.txt\` depois de configurar \`.env\`, pois sua saída contém
  sessões e senhas em texto claro;
- revogue cookies e troque senhas caso esse arquivo já tenha sido compartilhado.

Consulte a documentação oficial de
[segurança da Data API](https://supabase.com/docs/guides/api/securing-your-api)
e de
[Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
antes de trocar os dados fictícios por dados reais.

## Dados de sessão suportados

- Cookies exportados do Chrome/Cookie-Editor, incluindo HttpOnly, Secure,
  SameSite e expiração.
- \`local_storage\` e \`session_storage\` no formato objeto chave/valor.
- \`proxy_url\` por conta, sem registrar usuário ou senha do proxy.
- \`user_agent\` por conta.

\`indexed_db\` ainda não é restaurado porque o formato do exemplo lista bancos,
mas não fornece um snapshot portável do esquema e dos registros. Algumas
plataformas podem exigir IndexedDB, passkey, MFA, fingerprint do dispositivo ou
o mesmo proxy; nesses casos, apenas cookies e Web Storage podem não bastar.

Cookies também podem estar expirados ou revogados. O painel ignora cookies
inválidos e informa apenas a quantidade, nunca os nomes ou valores.

## Verificação

\`\`\`powershell
npm test
npm run check
\`\`\`

Os testes usam dados inventados. Eles não abrem nem alteram contas reais, e o
aplicativo não grava nada no Supabase.
