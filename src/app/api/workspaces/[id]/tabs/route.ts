import { NextResponse } from "next/server"
import path from 'path'
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import { ChatBubble, ChatTab, ComposerData, ComposerChat, ComposerContext, ComposerMessage } from "@/types/workspace"

interface RawTab {
  tabId: string;
  chatTitle: string;
  lastSendTime: number;
  bubbles: ChatBubble[];
}

const safeParseTimestamp = (timestamp: number | undefined): string => {
  try {
    if (!timestamp) {
      return new Date().toISOString();
    }
    return new Date(timestamp).toISOString();
  } catch (error) {
    console.error('Error parsing timestamp:', error, 'Raw value:', timestamp);
    return new Date().toISOString();
  }
};

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const workspacePath = process.env.WORKSPACE_PATH || ''
    const dbPath = path.join(workspacePath, params.id, 'state.vscdb')

    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    })

    const chatResult = await db.get(`
      SELECT value FROM ItemTable
      WHERE [key] = 'workbench.panel.aichat.view.aichat.chatdata'
    `)

    const composerResult = await db.get(`
      SELECT value FROM ItemTable
      WHERE [key] = 'composer.composerData'
    `)

    await db.close()

    if (!chatResult && !composerResult) {
      return NextResponse.json({ error: 'No chat data found' }, { status: 404 })
    }

    const response: { tabs: ChatTab[], composers?: ComposerData } = { tabs: [] }

    if (chatResult) {
      const chatData = JSON.parse(chatResult.value)
      response.tabs = chatData.tabs.map((tab: RawTab) => ({
        id: tab.tabId,
        title: tab.chatTitle?.split('\n')[0] || `Chat ${tab.tabId.slice(0, 8)}`,
        timestamp: safeParseTimestamp(tab.lastSendTime),
        bubbles: tab.bubbles
      }))
    }

    if (composerResult) {
      const globalDbPath = path.join(workspacePath, '..', 'globalStorage', 'state.vscdb')
      const composers: ComposerData = JSON.parse(composerResult.value)
      const keys = composers.allComposers.map((it) => `composerData:${it.composerId}`)
      const placeholders = keys.map(() => '?').join(',')

      const globalDb = await open({
        filename: globalDbPath,
        driver: sqlite3.Database
      })

      const composersBodyResult = await globalDb.all(`
        SELECT value FROM cursorDiskKV
        WHERE [key] in (${placeholders})
      `, keys)

      await globalDb.close()

      if (composersBodyResult) {
        // This will now be an array of Promises if we need to fetch message details
        const composerPromises = composersBodyResult.map(async (composerRecord) => {
          const composer: ComposerChat = JSON.parse(composerRecord.value);

          // Check if full conversation is missing but headers are present
          if ((!composer.conversation || composer.conversation.length === 0) &&
              composer.fullConversationHeadersOnly &&
              composer.fullConversationHeadersOnly.length > 0) {

            const messageKeys = composer.fullConversationHeadersOnly.map(header => header.bubbleId);
            
            if (messageKeys.length > 0) {
              // We'll add the database query for these keys in the next step
              // For now, let's log that we would fetch them
              console.log(`Workspace ${params.id}, Composer ${composer.composerId}: Would fetch details for ${messageKeys.length} messages using keys: ${messageKeys.join(', ')}`);
              
              // Placeholder: In a real scenario, you'd fetch and populate composer.conversation here
              // For now, let's assign the headers to the conversation to see a structural change if nothing else
              // This is temporary and will be replaced by actual messages
              composer.conversation = composer.fullConversationHeadersOnly.map((header: { bubbleId: string; type: 1 | 2; serverBubbleId?: string }) => ({
                bubbleId: header.bubbleId,
                type: header.type,
                text: `[Details for ${header.bubbleId} not fetched yet]`, // Placeholder text
                richText: '', // Placeholder
                context: {} as ComposerContext, // Placeholder, assuming ComposerContext structure
                timestamp: Date.now() // Placeholder
              }));
            }
          }
          return composer;
        });

        // Resolve all promises (important if async operations are involved)
        composers.allComposers = await Promise.all(composerPromises);
        response.composers = composers;
      }
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Failed to get workspace data:', error)
    return NextResponse.json({ error: 'Failed to get workspace data' }, { status: 500 })
  }
}
