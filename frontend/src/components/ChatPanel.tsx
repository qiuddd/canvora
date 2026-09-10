import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@canvora/shared';
import type { ChatStatus } from '../api/client';
import { getChatStatus, saveChatKey, sendChat, testChatKey } from '../api/client';

interface Props {
  root: string;
  /** 当前画布上选中的提示词节点的文本，可以一键填入输入框。 */
  promptDraft?: string;
  onInsertToCanvas?: (text: string) => void;
}

interface Bubble extends ChatMessage { id: string; error?: boolean }

const SYSTEM_PROMPT = '你是 Canvora 里的创作助手。用户在做 AI 短片、动画和社交平台素材。回答用简体中文，简短直接，能给出可直接使用的提示词或文案。';

export function ChatPanel({ root, promptDraft, onInsertToCanvas }: Props) {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const [showKey, setShowKey] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshStatus = () => { void getChatStatus(root).then(setStatus).catch(() => setStatus(null)); };
  useEffect(refreshStatus, [root]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages, sending]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const next: Bubble[] = [...messages, { id: crypto.randomUUID(), role: 'user', content: text }];
    setMessages(next);
    setDraft('');
    setSending(true);
    try {
      const payload: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...next.map(({ role, content }) => ({ role, content }))];
      const reply = await sendChat(payload, undefined, root);
      setMessages((list) => [...list, { id: crypto.randomUUID(), role: 'assistant', content: reply.content }]);
      refreshStatus();
    } catch (error) {
      setMessages((list) => [...list, { id: crypto.randomUUID(), role: 'assistant', content: error instanceof Error ? error.message : '发送失败', error: true }]);
    } finally {
      setSending(false);
    }
  };

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    try {
      await saveChatKey(keyDraft.trim(), root);
      setKeyDraft('');
      setKeyMessage('已加密保存到工作区，不会出现在日志和 git 里。');
      refreshStatus();
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : '保存失败');
    }
  };

  const testKey = async () => {
    setKeyMessage('正在测试…');
    try {
      const result = await testChatKey(keyDraft.trim() || undefined, root);
      setKeyMessage(`连接成功，可用模型：${result.models.join('、')}`);
      refreshStatus();
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : '测试失败');
    }
  };

  return <div className="chat">
    {!status?.configured && <div className="chat-setup">
      <h3>接入 DeepSeek</h3>
      <p className="muted">密钥只保存在你本机的工作区（加密），不会发到前端以外的地方，也不写进日志。</p>
      <div className="chat-key-row">
        <input type={showKey ? 'text' : 'password'} value={keyDraft} placeholder="sk-..." onChange={(event) => setKeyDraft(event.target.value)} />
        <button className="small-button" onClick={() => setShowKey((value) => !value)}>{showKey ? '隐藏' : '显示'}</button>
      </div>
      <div className="chat-key-row">
        <button className="primary-button" onClick={saveKey}>保存密钥</button>
        <button className="ghost-button" onClick={testKey}>测试连接</button>
      </div>
      {keyMessage && <p className="muted">{keyMessage}</p>}
      <p className="muted tiny">提示：建议只在服务商后台创建带消费上限的子密钥，不要用主账号密钥。</p>
    </div>}

    {status?.configured && <div className="chat-status">
      <span className="status-dot online" />
      DeepSeek 已接入（尾号 {status.last4}）· 模型 {status.defaultModel}
      <button className="link-button" onClick={refreshStatus}>刷新</button>
    </div>}

    <div className="chat-list" ref={listRef}>
      {messages.length === 0 && <p className="muted chat-empty">问它点什么，比如「帮我把『一只猫坐在窗边』扩写成一段电影感提示词」。</p>}
      {messages.map((message) => <div key={message.id} className={`bubble ${message.role} ${message.error ? 'error' : ''}`}>
        <div className="bubble-text">{message.content}</div>
        {message.role === 'assistant' && !message.error && onInsertToCanvas && <button className="link-button" onClick={() => onInsertToCanvas(message.content)}>填入画布提示词节点</button>}
      </div>)}
      {sending && <div className="bubble assistant"><div className="bubble-text muted">正在思考…</div></div>}
    </div>

    <div className="chat-input">
      {promptDraft && <button className="link-button" onClick={() => setDraft(promptDraft)}>填入画布上选中的提示词</button>}
      <textarea
        value={draft}
        placeholder="输入消息，Ctrl+Enter 发送"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }}
      />
      <button className="primary-button" disabled={sending || !draft.trim()} onClick={() => void send()}>{sending ? '发送中…' : '发送'}</button>
    </div>
  </div>;
}
