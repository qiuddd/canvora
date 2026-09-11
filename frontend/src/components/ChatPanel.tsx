import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@canvora/shared';
import type { ChatStatus } from '../api/client';
import { getChatStatus, saveChatKey, sendChat, testChatKey } from '../api/client';

interface Props {
  root: string;
  promptDraft?: string;
  onInsertToCanvas?: (text: string) => void;
}

interface Attachment { id: string; name: string; dataUrl: string }
interface Bubble extends ChatMessage { id: string; error?: boolean; images?: string[] }

const SYSTEM_PROMPT = '你是 Canvora 里的创作助手。用户在做 AI 短片、动画和社交平台素材。回答用简体中文，简短直接，能给出可直接使用的提示词或文案。';
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export function ChatPanel({ root, promptDraft, onInsertToCanvas }: Props) {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [visionHint, setVisionHint] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const refreshStatus = () => { void getChatStatus(root).then(setStatus).catch(() => setStatus(null)); };
  useEffect(refreshStatus, [root]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages, sending]);

  const attachImages = async (files: File[]) => {
    const accepted: Attachment[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) { setVisionHint(`「${file.name}」不是图片，已跳过`); continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { setVisionHint(`「${file.name}」超过 4MB，请先压缩再用`); continue; }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      accepted.push({ id: crypto.randomUUID(), name: file.name, dataUrl });
    }
    if (accepted.length) setAttachments((list) => [...list, ...accepted]);
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || sending) return;
    const images = attachments.map((item) => item.dataUrl);
    const next: Bubble[] = [...messages, { id: crypto.randomUUID(), role: 'user', content: text || '（图片）', images }];
    setMessages(next);
    setDraft('');
    setAttachments([]);
    setSending(true);
    setVisionHint('');
    try {
      // 有图片时按官方文档的多模态格式发送（deepseek-flash 支持读图）。
      // 注意不要把 max_tokens 设得太小：模型会先写推理内容，预算不够时正文会是空的。
      const content: ChatMessage['content'] | Array<Record<string, unknown>> = images.length
        ? [
          ...(text ? [{ type: 'text', text }] : [{ type: 'text', text: '看看这张图，用一句话描述。' }]),
          ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
        ]
        : text;
      const payload = [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...next.map((item, index) => ({ role: item.role, content: index === next.length - 1 ? content : item.content }))] as ChatMessage[];
      const reply = await sendChat(payload, undefined, root);
      setMessages((list) => [...list, { id: crypto.randomUUID(), role: 'assistant', content: reply.content }]);
      refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : '发送失败';
      setMessages((list) => [...list, { id: crypto.randomUUID(), role: 'assistant', content: message, error: true }]);
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
      {messages.length === 0 && <p className="muted chat-empty">问它点什么，比如「帮我把『一只猫坐在窗边』扩写成一段电影感提示词」。也可以直接把图片拖到下面。</p>}
      {messages.map((message) => <div key={message.id} className={`bubble ${message.role} ${message.error ? 'error' : ''}`}>
        {message.images?.length ? <div className="bubble-images">{message.images.map((src, index) => <img key={index} src={src} alt="附件" />)}</div> : null}
        <div className="bubble-text">{message.content}</div>
        {message.role === 'assistant' && !message.error && onInsertToCanvas && <button className="link-button" onClick={() => onInsertToCanvas(message.content)}>填入画布提示词节点</button>}
      </div>)}
      {sending && <div className="bubble assistant"><div className="bubble-text muted">正在思考…</div></div>}
    </div>

    {visionHint && <div className="chat-hint">{visionHint}</div>}

    <div className="chat-input">
      {promptDraft && <button className="link-button" onClick={() => setDraft(promptDraft)}>填入画布上选中的提示词</button>}
      {attachments.length > 0 && <div className="attach-strip">
        {attachments.map((item) => <span className="attach-chip" key={item.id}>
          <img src={item.dataUrl} alt={item.name} />
          <button onClick={() => setAttachments((list) => list.filter((entry) => entry.id !== item.id))}>×</button>
        </span>)}
      </div>}
      <textarea
        value={draft}
        placeholder="输入消息，Ctrl+Enter 发送；图片可以直接拖到这里或点下面的「图片」"
        onChange={(event) => setDraft(event.target.value)}
        onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) void attachImages(files); }}
        onDrop={(event) => { event.preventDefault(); const files = Array.from(event.dataTransfer.files); if (files.length) void attachImages(files); }}
        onDragOver={(event) => event.preventDefault()}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }}
      />
      <div className="chat-actions">
        <button className="small-button" onClick={() => imageInput.current?.click()}>图片</button>
        <span className="muted tiny">图片只用于本次对话，不会上传到任何第三方（除你配置的接口）</span>
        <button className="primary-button" disabled={sending || (!draft.trim() && !attachments.length)} onClick={() => void send()}>{sending ? '发送中…' : '发送'}</button>
      </div>
    </div>
    <input ref={imageInput} hidden type="file" accept="image/*" multiple onChange={(event) => { if (event.target.files?.length) void attachImages(Array.from(event.target.files)); event.target.value = ''; }} />
  </div>;
}
