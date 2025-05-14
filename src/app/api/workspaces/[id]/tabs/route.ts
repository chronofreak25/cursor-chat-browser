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

      const composersBodyResult = await globalDb.all(
        `SELECT value FROM cursorDiskKV
        WHERE [key] in (${placeholders})`,
        keys
      )

      if (composersBodyResult) {
        const composerPromises = composersBodyResult.map(async (composerRecord) => {
          const composer: ComposerChat = JSON.parse(composerRecord.value);

          // Check if full conversation is missing but headers are present
          if ((!composer.conversation || composer.conversation.length === 0) &&
              composer.fullConversationHeadersOnly &&
              composer.fullConversationHeadersOnly.length > 0) {

            const messageKeys = composer.fullConversationHeadersOnly.map(header => `bubbleId:${composer.composerId}:${header.bubbleId}`);
            
            if (messageKeys.length > 0) {
              console.log(`Workspace ${params.id}, Composer ${composer.composerId}: Attempting to fetch details for ${messageKeys.length} messages using correct keys (e.g., ${messageKeys[0]})`);
              
              try {
                const messagePlaceholders = messageKeys.map(() => '?').join(',');
                const messageDetailsResults = await globalDb.all(
                  `SELECT value FROM cursorDiskKV WHERE key IN (${messagePlaceholders})`,
                  messageKeys
                );

                if (messageDetailsResults && messageDetailsResults.length > 0) {
                  const messagesMap = new Map<string, ComposerMessage>();
                  messageDetailsResults.forEach(row => {
                    const message: ComposerMessage = JSON.parse(row.value);
                    messagesMap.set(message.bubbleId, message);
                  });

                  // Reconstruct conversation in the correct order using headers
                  composer.conversation = composer.fullConversationHeadersOnly
                    .map((header: { bubbleId: string; type: 1 | 2; serverBubbleId?: string }) => {
                      const fullMessage = messagesMap.get(header.bubbleId);
                      if (fullMessage) {
                        // Ensure the type from the header (which is 1 or 2) is consistent
                        // or use it if the fullMessage doesn't have type (though it should)
                        return {
                          ...fullMessage,
                          type: header.type, // Prioritize type from header if needed, or ensure consistency
                        };
                      }
                      // Fallback if a specific message detail wasn't found (should ideally not happen if keys are correct)
                      return {
                        bubbleId: header.bubbleId,
                        type: header.type,
                        text: `[Error: Details for ${header.bubbleId} not found in DB]`,
                        richText: '',
                        context: {} as ComposerContext,
                        timestamp: Date.now()
                      };
                    });
                  console.log(`Workspace ${params.id}, Composer ${composer.composerId}: Successfully fetched and mapped ${messagesMap.size} message details.`);
                } else {
                  console.log(`Workspace ${params.id}, Composer ${composer.composerId}: No message details found in DB for correct keys (e.g., ${messageKeys[0]})`);
                  // Fallback: Keep placeholder to indicate fetching was attempted but failed
                  composer.conversation = composer.fullConversationHeadersOnly.map((header: { bubbleId: string; type: 1 | 2; serverBubbleId?: string }) => ({
                      bubbleId: header.bubbleId,
                      type: header.type,
                      text: `[Details for ${header.bubbleId} not found in DB (no results)]`,
                      richText: '',
                      context: {} as ComposerContext,
                      timestamp: Date.now()
                  }));
                }
              } catch (e) {
                console.error(`Workspace ${params.id}, Composer ${composer.composerId}: Error fetching message details:`, e);
                // Fallback: Keep placeholder to indicate an error occurred
                composer.conversation = composer.fullConversationHeadersOnly.map((header: { bubbleId: string; type: 1 | 2; serverBubbleId?: string }) => ({
                    bubbleId: header.bubbleId,
                    type: header.type,
                    text: `[Error fetching details for ${header.bubbleId}]`,
                    richText: '',
                    context: {} as ComposerContext,
                    timestamp: Date.now()
                }));
              }
            }
          }
          return composer;
        });

        // Resolve all promises (important if async operations are involved)
        composers.allComposers = await Promise.all(composerPromises);
        response.composers = composers;
      }

      await globalDb.close(); // Close globalDb AFTER all processing is done
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Failed to get workspace data:', error)
    return NextResponse.json({ error: 'Failed to get workspace data' }, { status: 500 })
  }
}
