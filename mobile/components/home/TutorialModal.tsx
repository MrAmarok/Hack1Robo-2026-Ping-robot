import { Modal, View, Text, TouchableOpacity } from 'react-native';
import { styles } from './styles';
import React from 'react';

type TutorialModalProps = {
  showTutorial: boolean;
  TUTORIAL_PAGES: { title: string; text: string; }[];
  tutorialStep: number;
  handleSkipTutorial: () => Promise<void>;
  handleNextTutorial: () => Promise<void>;
  isLastStep: boolean;
};

export function TutorialModal({
  showTutorial,
  TUTORIAL_PAGES,
  tutorialStep,
  handleSkipTutorial,
  handleNextTutorial,
  isLastStep,
}: TutorialModalProps) {
  return (
    <>
      <Modal visible={showTutorial} transparent animationType="fade">
        <View style={styles.tutoBackdrop}>
          <View style={styles.tutoCard}>
            <Text style={styles.tutoTitle}>{TUTORIAL_PAGES[tutorialStep].title}</Text>
            <Text style={styles.tutoText}>{TUTORIAL_PAGES[tutorialStep].text}</Text>

            <View style={styles.tutoDotsRow}>
              {TUTORIAL_PAGES.map((_, i) => (
                <View
                  key={i}
                  style={[styles.tutoDot, tutorialStep === i && styles.tutoDotActive]}
                />
              ))}
            </View>

            <View style={styles.tutoActions}>
              <TouchableOpacity
                onPress={handleSkipTutorial}
                style={[styles.primaryBtn, { backgroundColor: '#132029', flex: 1, marginRight: 8 }]}
              >
                <Text style={styles.primaryBtnText}>Passer</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleNextTutorial}
                style={[styles.primaryBtn, { flex: 1 }]}
              >
                <Text style={styles.primaryBtnText}>{isLastStep ? 'Terminer' : 'Suivant'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
